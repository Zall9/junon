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
import errno
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

from junon import handshake_cache, instances
from junon.instances import Instance
from junon.serve import DEFAULT_IDLE_MINUTES

log = logging.getLogger("junon.attach")

#: How long a fresh instance may take to answer before attaching gives up. Language servers that
#: index a large project for the first time are the slow case; two seconds is the usual one.
DEFAULT_START_TIMEOUT_SECONDS = 120.0

#: How long an instance that has registered but is not answering yet is given before a second one is
#: started for the same root. Long enough to cover a cold start under load — twenty-three at once,
#: measured — and short enough that a genuinely wedged instance does not hold a session for ever.
_SETTLE_SECONDS = 30.0

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

        if existing is not None:
            # Registered but not answering *yet*. Treating that as absent is how one root ended up
            # with two instances on 2026-09-21: twenty-three were booting at once, the first had
            # published its port but had not finished starting its language servers, and the second
            # attach gave up on it immediately. It gets a bounded wait before being written off.
            started_waiting = last = clock()
            while clock() - started_waiting < _SETTLE_SECONDS:
                if alive(existing.url):
                    return existing
                if instances.instance_for(root) is None:
                    break  # it died rather than started; stop waiting for it
                time.sleep(poll_seconds)
                now = clock()
                if now == last:
                    # A clock that does not move cannot expire a wait, and a test that injects a
                    # still one is asking what happens *now*, not in thirty seconds. Without this
                    # the loop never ends — it hung the suite once, with `time.sleep(0)`.
                    break
                last = now

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


def never_delivered(error: BaseException | None) -> bool:
    """Whether this failure means the request never reached the instance.

    A connection that was refused carries no bytes: the instance was already gone when the socket
    was attempted, so the call can be sent again to a fresh one without any chance of applying it
    twice. Every other failure — a connection that opened and then ended, a response that never
    came — leaves the question open, and an open question is not a licence to retry a write.

    Walks causes and exception groups because the transport raises through several layers: an
    `httpx.ConnectError` arrives wrapped in a task group's `ExceptionGroup`, inside an
    `ExceptionGroup` of the session's own.
    """
    seen: set[int] = set()

    def walk(item: BaseException | None) -> bool:
        if item is None or id(item) in seen:
            return False
        seen.add(id(item))
        if isinstance(item, ConnectionRefusedError):
            return True
        if type(item).__name__ in {"ConnectError", "ConnectTimeout"}:
            return True
        if isinstance(item, OSError) and item.errno == errno.ECONNREFUSED:
            return True
        for nested in getattr(item, "exceptions", ()) or ():
            if walk(nested):
                return True
        return walk(item.__cause__) or walk(item.__context__)

    return walk(error)


class UpstreamRestarted(RuntimeError):
    """The instance died **while a request was in flight**, and that request will not be retried.

    Distinct from [UpstreamGone] because the two need opposite answers. A connection already known
    to be dead has sent nothing, so reconnecting and sending is free of consequence. A request that
    was in flight may have run — `replace_content` writes the file before it answers — and sending
    it again would apply it twice. So the connection is rebuilt for everything that follows, and
    this one call is reported as what it is: a request whose fate nobody can know.
    """


class Upstream:
    """The connection to the instance, held in its own task, and **rebuilt when the instance goes**.

    The HTTP transport runs a task group; when the instance dies that group raises, and an exception
    there must not take the stdio server down with it — the host would see a closed pipe and nothing
    else. So the connection lives in its own task, and its death is a fact this class can act on.

    **Acting on it means reconnecting.** Until 0.3.7 it meant reporting: every call from then on
    answered "the shared JUNON stopped answering", and the session was finished until its host was
    restarted. That is what made a shared instance impossible to replace — `junon instances --stop`
    had to refuse any instance with a session on it, which is every instance anyone cares about, so
    an upgrade could not be applied without closing the editor someone was working in. A relay that
    reconnects turns that into an event nobody notices: the instance goes, the next call finds a
    fresh one — on the installed JUNON, since a superseded instance is no longer offered — and the
    session carries on.
    """

    def __init__(
        self,
        root: str,
        on_notification: Callable[[Any], Any],
        idle_minutes: float = DEFAULT_IDLE_MINUTES,
        passthrough: list[str] | None = None,
        find: Callable[..., Instance] = find_or_start,
        on_reconnect: Callable[[], Any] | None = None,
    ) -> None:
        self.root = root
        self._on_notification = on_notification
        self._idle_minutes = idle_minutes
        self._passthrough = passthrough or []
        self._find = find
        self._on_reconnect = on_reconnect
        self.instance: Instance | None = None
        self.session: Any = None
        self.init: Any = None
        self.error: Exception | None = None
        self.reconnections = 0
        self._ready = asyncio.Event()
        self._dead = asyncio.Event()
        self._release = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def _hold(self, url: str) -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client

        try:
            async with streamable_http_client(url) as (read, write, _):
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

    async def _attach_to(self, instance: Instance) -> None:
        self.instance = instance
        self.error = None
        self._ready = asyncio.Event()
        self._dead = asyncio.Event()
        self._release = asyncio.Event()
        self._task = asyncio.create_task(self._hold(instance.url), name="junon-upstream")
        await self._ready.wait()
        if self.session is None:
            raise UpstreamGone(str(self.error))
        # The session belongs to *this* instance now. Without re-announcing it the fresh instance
        # sees nobody attached and leaves at its next tick — superseded-and-free exits at once since
        # 0.3.4 — and the relay would spend its life starting instances that immediately give up.
        instances.publish_client(self.root, instance.pid)

    async def open(self) -> None:
        # In a thread, like every other call to it here: `find_or_start` probes the instance with
        # `asyncio.run`, which raises inside a running loop — and this one runs inside the relay's.
        await self._attach_to(
            await asyncio.to_thread(
                self._find, self.root, self._idle_minutes, DEFAULT_START_TIMEOUT_SECONDS, self._passthrough
            )
        )

    async def _reconnect(self) -> bool:
        """Finds or starts an instance and binds to it. False when even that fails."""
        previous = self.instance.pid if self.instance else None
        await self._stop_task()
        try:
            instance = await asyncio.to_thread(
                self._find, self.root, self._idle_minutes, DEFAULT_START_TIMEOUT_SECONDS, self._passthrough
            )
            await self._attach_to(instance)
        except Exception as error:  # noqa: BLE001 - reported to the model, not raised at it
            self.error = error
            return False
        self.reconnections += 1
        log.warning(
            "the shared JUNON for %s changed (pid %s -> %s); this session reattached",
            self.root,
            previous,
            instance.pid,
        )
        if self._on_reconnect is not None:
            await self._on_reconnect()
        return True

    async def _stop_task(self) -> None:
        self._release.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - closing; nothing to report
                pass
            self._task = None

    async def close(self) -> None:
        await self._stop_task()

    async def call(self, method: Callable[..., Any], *args: Any, _retried: bool = False) -> Any:
        """`method` on the live session, reconnecting and retrying when nothing was delivered.

        **A dead instance is discovered by sending, not before.** The transport is streamable HTTP:
        there is no socket sitting open to break, so killing the instance leaves this side believing
        it has a session until the next request fails. Measured on 2026-09-16 while building this —
        the first design assumed an idle connection would notice, and every call after a kill came
        back "in flight when it died", which was both wrong and useless.

        So the question is not *when* we learned, it is *whether the request was delivered*. A
        refused connection delivered nothing, and retrying it on a fresh instance is free of
        consequence. Anything else — a request that went out and whose answer never came — may have
        run, and a write must not be applied twice.
        """
        if self.session is None and not await self._reconnect():
            raise UpstreamGone(str(self.error) if self.error else "connection closed")

        request = asyncio.ensure_future(method(self.session, *args))
        dead = asyncio.ensure_future(self._dead.wait())
        vanished = asyncio.ensure_future(self._instance_vanished())
        done, _ = await asyncio.wait(
            {request, dead, vanished}, return_when=asyncio.FIRST_COMPLETED
        )
        for pending in (dead, vanished):
            if pending not in done:
                pending.cancel()

        if request in done:
            try:
                return request.result()
            except Exception as error:  # noqa: BLE001 - classified below, not swallowed
                if _retried or not never_delivered(error) or not await self._reconnect():
                    raise
                return await self.call(method, *args, _retried=True)

        # The instance ended while this was outstanding. The raced request is abandoned and the
        # connection torn down, so the next call rebuilds rather than talking to a dead session.
        request.cancel()
        await self._stop_task()
        self.session = None
        if not _retried and never_delivered(self.error) and await self._reconnect():
            return await self.call(method, *args, _retried=True)
        raise UpstreamRestarted(str(self.error) if self.error else "the instance stopped")

    async def _instance_vanished(self, interval: float = 0.5) -> None:
        """Returns once the instance's process is gone. The only warning this transport gives.

        Streamable HTTP keeps no socket open between calls, so a killed instance is invisible until
        something is sent — and a request that was *already* outstanding when it died is never
        answered and never fails either. Measured on 2026-09-16: a call hung for the full sixty
        seconds of a test timeout with nothing raised anywhere. The pid is the fact that settles it,
        and this class already knows it.
        """
        import psutil

        pid = self.instance.pid if self.instance else None
        if pid is None:
            await asyncio.Event().wait()  # nothing to watch; never wins the race
        while psutil.pid_exists(pid):
            await asyncio.sleep(interval)


async def relay(
    root: str,
    idle_minutes: float = DEFAULT_IDLE_MINUTES,
    passthrough: list[str] | None = None,
) -> None:
    """Serves MCP on stdio, answering from the shared instance and following it when it is replaced."""
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
        if isinstance(error, UpstreamRestarted):
            return (
                f"The shared JUNON for {root} was replaced while this call was in flight, so its "
                "result is unknown — it may have run, or not. Nothing was retried, because a call "
                "that writes must not be applied twice. Check whatever it was meant to change, then "
                "ask again: this session is already reattached to the new instance."
            )
        return (
            f"The shared JUNON for {root} could not be reached, and starting a new one failed "
            f"({type(error).__name__}: {error})."
        )

    async def tools_may_have_changed() -> None:
        # A different instance can expose a different toolset — a new JUNON release, say. The host
        # is told to ask again rather than being left with the list the old one published.
        session = downstream.get("session")
        if session is not None:
            await session.send_tool_list_changed()

    upstream = Upstream(
        root,
        on_upstream_message,
        idle_minutes=idle_minutes,
        passthrough=passthrough,
        on_reconnect=tools_may_have_changed,
    )

    # **Opening a session must not start a project.** A host launches one relay per registered
    # project the moment it starts — opencode had 119 of them — and until 0.3.8 each of those
    # immediately started the project's instance and its language servers, whether or not anyone
    # would ever touch it: 23 instances, 55 language servers, 4.16 GB, measured on 2026-09-21.
    #
    # So the two things a host asks at start-up are answered from a file recorded by whichever relay
    # last had a live instance, and the instance itself is started by the first request that is
    # genuinely about the project. With nothing recorded, this behaves exactly as it did before.
    def record(handshake: handshake_cache.Handshake) -> None:
        # Recording is an optimisation for the *next* session. A full disk, a read-only home, a
        # registry someone chmod'd — none of those are reasons for this session to fail.
        try:
            handshake_cache.write(handshake)
        except OSError as error:
            log.warning("the handshake could not be recorded (%s); sessions will keep starting "
                        "their project at open", error)

    recorded = handshake_cache.read()
    if recorded is None:
        await upstream.open()
        record(handshake_cache.capture(
            upstream.init, (await upstream.call(ClientSession.list_tools)).tools, root
        ))
        recorded = handshake_cache.read()

    async def ensure_upstream() -> None:
        """Starts the instance the first time something really needs it, and reconciles the cache."""
        if upstream.session is not None or upstream.instance is not None:
            return
        await upstream.open()
        live = handshake_cache.capture(
            upstream.init, (await upstream.call(ClientSession.list_tools)).tools, root
        )
        if recorded is None or live.tool_names() != recorded.tool_names():
            # The file was answering for a toolset this instance does not have. Rewritten, and the
            # host told to ask again — the notification it already honours.
            record(live)
            log.warning(
                "the recorded toolset did not match %s; it has been rewritten and the host notified",
                root,
            )
            await tools_may_have_changed()

    try:
        instructions = recorded.instructions if recorded else (upstream.init.instructions if upstream.init else None)
        server: Server = Server("junon", instructions=instructions)

        @server.list_tools()
        async def list_tools() -> list[types.Tool]:
            downstream["session"] = server.request_context.session
            if upstream.session is None and recorded is not None:
                # Answered without a project: this is the whole point of the change.
                return [types.Tool.model_validate(tool) for tool in recorded.tools]
            return (await upstream.call(ClientSession.list_tools)).tools

        # No input validation here: the instance validates, and validating twice against a
        # schema fetched once would refuse arguments the instance now accepts.
        @server.call_tool(validate_input=False)
        async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
            downstream["session"] = server.request_context.session
            try:
                await ensure_upstream()
                return await upstream.call(ClientSession.call_tool, name, arguments)
            except Exception as error:  # noqa: BLE001 - reported to the model, not raised at it
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=gone(error))], isError=True
                )

        # What the instance really offers when there is nothing recorded — the pre-0.3.8 test, kept
        # exactly, so the fallback path advertises neither more nor less than it used to.
        offers_prompts = (
            recorded.prompts
            if recorded is not None
            else upstream.init is not None and upstream.init.capabilities.prompts is not None
        )
        if offers_prompts:

            @server.list_prompts()
            async def list_prompts() -> list[types.Prompt]:
                await ensure_upstream()
                return (await upstream.call(ClientSession.list_prompts)).prompts

            @server.get_prompt()
            async def get_prompt(name: str, arguments: dict[str, str] | None) -> types.GetPromptResult:
                await ensure_upstream()
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

    # Nothing is started here. Until 0.3.8 this checked the project could be served by starting its
    # instance, which cost 4 GB across a host's twenty-three registered projects for the sake of an
    # early error message. A project that cannot be served now says so at the first call that needs
    # it, in the same words — the trade is stated in docs/LAZY_ATTACH_PLAN.md §6.
    atexit.register(instances.unpublish_client)
    asyncio.run(relay(root, options.idle_minutes, passthrough))
    return 0
