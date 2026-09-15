"""``junon attach`` — what an agent host launches: a stdio MCP server that finds or starts the shared
instance for the project and relays to it.

The host's contract does not change — it still spawns a command and speaks MCP over its stdio —
but the language servers, the index and the project state live in one ``junon serve`` per project
root, shared by every session on it (``docs/SHARED_JUNON_PLAN.md`` §3.2). This process is the thin
end: it resolves the project the way ``--project-from-cwd`` does, takes a lock for that root so two
sessions starting together do not start two instances, finds a live instance or spawns one and waits
until it answers, announces itself as a **client** so the instance stays alive, and then relays
every request until the host closes the pipe.

What is relayed: ``tools/list``, ``tools/call``, the instance's ``instructions`` from its initialize
result — Serena's *read the Instructions Manual* has to reach the model — ``prompts`` when the
instance offers them, and the ``tools/list_changed`` notification. Nothing is reinterpreted.

The instance it starts is launched from **this** ``junon`` package by path, not from whatever
``python -m junon`` resolves to, so a session and the instance it created always run the same code.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import fcntl
import hashlib
import logging
import os
import subprocess
import sys
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from junon import instances
from junon.instances import Instance
from junon.serve import DEFAULT_IDLE_MINUTES

log = logging.getLogger("junon.attach")

#: How long a fresh instance may take to answer before attaching gives up. Language servers that
#: index a large project for the first time are the slow case; two seconds is the usual one.
DEFAULT_START_TIMEOUT_SECONDS = 120.0

#: Runs the `junon` package that contains this file, whatever is installed (see the module docstring).
_LAUNCH = "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('junon', run_name='__main__', alter_sys=True)"


# --- resolving the project ---------------------------------------------------------------------


def resolve_root(project: str | None) -> str | None:
    """An explicit `--project`, else Serena's own rule: nearest `.serena/project.yml` or `.git` above cwd."""
    if project:
        return instances.normalise_root(project)
    from serena.cli import find_project_root

    found = find_project_root()
    return instances.normalise_root(found) if found else None


# --- finding or starting the instance ---------------------------------------------------------


def _key(root: str) -> str:
    return hashlib.sha1(root.encode("utf-8")).hexdigest()[:12]


@contextmanager
def _root_lock(root: str):
    """One starter per root at a time. The second attach blocks here, then finds what the first made."""
    directory = instances.registry_dir() / "locks"
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / f"{_key(root)}.lock", "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def serve_command(root: str, idle_minutes: float, passthrough: list[str]) -> list[str]:
    package_root = Path(__file__).resolve().parent.parent
    return [
        sys.executable,
        "-c",
        _LAUNCH,
        str(package_root),
        "serve",
        "--project",
        root,
        "--idle-minutes",
        str(idle_minutes),
        *passthrough,
    ]


#: Starts the instance from a short-lived middle process, so the instance is nobody's descendant.
#:
#: A new session (`start_new_session`) is not enough. Measured with opencode on 2026-09-15: the
#: instance was in its own session and still received a shutdown the second the host exited, while
#: the same instance started from a Python stdio client outlived it. Re-parented — the middle
#: process starts it and exits at once, launchd adopts it — the instance outlived opencode too. The
#: mechanism is presumably a walk of the MCP server's descendants; what is measured is that a
#: session boundary did not protect the instance and re-parenting did. The middle process prints
#: the pid.
_DETACH = (
    "import subprocess, sys\n"
    "log, cwd, *command = sys.argv[1:]\n"
    "with open(log, 'ab') as out:\n"
    "    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,"
    " start_new_session=True, cwd=cwd)\n"
    "print(child.pid)\n"
)


def spawn_serve(root: str, idle_minutes: float, passthrough: list[str]) -> int:
    """Starts an instance detached from this session, its output kept where `doctor` can find it."""
    logs = instances.registry_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"serve-{_key(root)}.log"
    with open(log_path, "ab") as out:
        out.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} started for {root}\n".encode())
    middle = subprocess.run(
        [sys.executable, "-c", _DETACH, str(log_path), root, *serve_command(root, idle_minutes, passthrough)],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=True,
    )
    return int(middle.stdout.strip())


async def _answers(url: str, timeout: float = 5.0) -> bool:
    """Whether an MCP session can be opened there right now — an entry alone does not say so."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async def go() -> None:
        async with streamable_http_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()

    try:
        await asyncio.wait_for(go(), timeout)
        return True
    except Exception:  # noqa: BLE001 - not up, not yet, or not any more: the same answer
        return False


def answers(url: str) -> bool:
    return asyncio.run(_answers(url))


class StartFailed(RuntimeError):
    pass


def find_or_start(
    root: str,
    idle_minutes: float = DEFAULT_IDLE_MINUTES,
    start_timeout: float = DEFAULT_START_TIMEOUT_SECONDS,
    passthrough: list[str] | None = None,
    launch: Callable[[str, float, list[str]], int] = spawn_serve,
    alive: Callable[[str], bool] = answers,
    clock: Callable[[], float] = time.monotonic,
    poll_seconds: float = 0.25,
) -> Instance:
    """The live instance for `root`, starting one if there is none that answers.

    An instance entry whose process is alive but whose port does not answer is treated as absent:
    it is starting, crashed short of listening, or wedged, and in every case a session needs one
    that answers. Under the root lock, so concurrent attaches converge on one instance.
    """
    with _root_lock(root):
        existing = instances.instance_for(root)
        if existing is not None and alive(existing.url):
            return existing

        pid = launch(root, idle_minutes, passthrough or [])
        deadline = clock() + start_timeout
        while clock() < deadline:
            candidate = instances.instance_for(root)
            if candidate is not None and candidate.pid == pid and alive(candidate.url):
                return candidate
            time.sleep(poll_seconds)
        raise StartFailed(
            f"the shared JUNON for {root} (pid {pid}) did not answer within {start_timeout:.0f}s; "
            f"its output is under {instances.registry_dir() / 'logs'}"
        )


# --- the relay ---------------------------------------------------------------------------------


class UpstreamGone(RuntimeError):
    """The instance's connection ended — it was killed, or its port stopped answering."""


class Upstream:
    """The connection to the instance, held in its own task so its death is a fact, not a crash.

    The HTTP transport runs a task group; when the instance dies that group raises, and an
    exception there must not take the stdio server down with it — the host would see a closed pipe
    and nothing else. Here it marks the connection dead, and every request from then on is answered
    with words. A request in flight is raced against that mark, because a response that will never
    arrive would otherwise be waited for indefinitely.
    """

    def __init__(self, url: str, on_notification: Callable[[Any], Any]) -> None:
        self.url = url
        self._on_notification = on_notification
        self.session: Any = None
        self.init: Any = None
        self.error: Exception | None = None
        self._ready = asyncio.Event()
        self._dead = asyncio.Event()
        self._release = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def _hold(self) -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client

        try:
            async with streamable_http_client(self.url) as (read, write, _):
                async with ClientSession(read, write, message_handler=self._on_notification) as session:
                    self.init = await session.initialize()
                    self.session = session
                    self._ready.set()
                    await self._release.wait()
        except Exception as error:  # noqa: BLE001 - whatever ended it is the reason we report
            self.error = error
        finally:
            self.session = None
            self._dead.set()
            self._ready.set()

    async def open(self) -> None:
        self._task = asyncio.create_task(self._hold(), name="junon-upstream")
        await self._ready.wait()
        if self.session is None:
            raise UpstreamGone(str(self.error))

    async def close(self) -> None:
        self._release.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - closing; nothing to report
                pass

    async def call(self, method: Callable[..., Any], *args: Any) -> Any:
        """`method` on the live session, or `UpstreamGone` the moment the connection is known dead."""
        session = self.session
        if session is None:
            raise UpstreamGone(str(self.error) if self.error else "connection closed")
        request = asyncio.ensure_future(method(session, *args))
        dead = asyncio.ensure_future(self._dead.wait())
        done, _ = await asyncio.wait({request, dead}, return_when=asyncio.FIRST_COMPLETED)
        if request in done:
            dead.cancel()
            return request.result()
        request.cancel()
        raise UpstreamGone(str(self.error) if self.error else "connection closed")


async def relay(instance: Instance, root: str) -> None:
    """Serves MCP on stdio, answering every request from the instance."""
    from mcp import ClientSession, types
    from mcp.server import NotificationOptions, Server
    from mcp.server.stdio import stdio_server

    downstream: dict[str, Any] = {}

    async def on_upstream_message(message: Any) -> None:
        # The one notification worth relaying: Serena announces a changed toolset this way.
        if isinstance(message, types.ServerNotification) and isinstance(
            message.root, types.ToolListChangedNotification
        ):
            session = downstream.get("session")
            if session is not None:
                await session.send_tool_list_changed()

    def gone(error: Exception) -> str:
        return (
            f"The shared JUNON for {root} stopped answering ({type(error).__name__}: {error}). "
            "A session started now gets a fresh instance; this one cannot continue."
        )

    upstream = Upstream(instance.url, on_upstream_message)
    await upstream.open()
    try:
        init = upstream.init
        server: Server = Server("junon", instructions=init.instructions)

        @server.list_tools()
        async def list_tools() -> list[types.Tool]:
            downstream["session"] = server.request_context.session
            return (await upstream.call(ClientSession.list_tools)).tools

        # No input validation here: the instance validates, and validating twice against a
        # schema fetched once would refuse arguments the instance now accepts.
        @server.call_tool(validate_input=False)
        async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
            downstream["session"] = server.request_context.session
            try:
                return await upstream.call(ClientSession.call_tool, name, arguments)
            except Exception as error:  # noqa: BLE001 - reported to the model, not raised at it
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=gone(error))], isError=True
                )

        if init.capabilities.prompts is not None:

            @server.list_prompts()
            async def list_prompts() -> list[types.Prompt]:
                return (await upstream.call(ClientSession.list_prompts)).prompts

            @server.get_prompt()
            async def get_prompt(name: str, arguments: dict[str, str] | None) -> types.GetPromptResult:
                return await upstream.call(ClientSession.get_prompt, name, arguments)

        options = server.create_initialization_options(NotificationOptions(tools_changed=True))
        async with stdio_server() as (stdio_read, stdio_write):
            await server.run(stdio_read, stdio_write, options)
    finally:
        await upstream.close()


# --- the command -------------------------------------------------------------------------------


def parse(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(
        prog="junon attach",
        description="Speak MCP on stdio for the shared JUNON of a project, starting it if needed.",
    )
    parser.add_argument("--project", default=None, help="project root; the working directory's project if omitted")
    parser.add_argument("--idle-minutes", type=float, default=DEFAULT_IDLE_MINUTES, help="passed to the instance this starts")
    parser.add_argument("--start-timeout", type=float, default=DEFAULT_START_TIMEOUT_SECONDS)
    # Anything else goes to the instance if this attach starts it: `--enable-web-dashboard false` and the like.
    return parser.parse_known_args(argv)


def run(argv: list[str]) -> int:
    # stdout is the MCP channel; every word of ours goes to stderr.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="junon attach: %(message)s")
    options, passthrough = parse(argv)
    root = resolve_root(options.project)
    if root is None:
        print(
            "junon attach: no project here — no .serena/project.yml or .git above the working "
            "directory. Pass --project.",
            file=sys.stderr,
        )
        return 2
    if not Path(root).is_dir():
        print(f"junon attach: {root} is not a directory", file=sys.stderr)
        return 2

    try:
        instance = find_or_start(root, options.idle_minutes, options.start_timeout, passthrough)
    except StartFailed as error:
        print(f"junon attach: {error}", file=sys.stderr)
        return 1

    instances.publish_client(root, instance.pid)
    atexit.register(instances.unpublish_client)
    asyncio.run(relay(instance, root))
    return 0
