"""``junon serve`` — one JUNON for one project, shared by every session on it.

Serena's HTTP transports already keep a single agent across connections; this command adds the
three things that make sharing safe (``docs/SHARED_JUNON_PLAN.md`` §3.1):

- the instance **announces itself** — root and port — so a session can find it
  (:mod:`junon.instances`);
- the project is **pinned**: ``activate_project`` for any other project is refused. A shared
  instance that one session can switch under the others is a trap that was walked into by hand,
  twice, the day this was designed;
- the instance **stops when nobody uses it**. The sessions that started it usually end first, so
  the instance owns its own death: a watchdog exits the process once no attached session has been
  alive for the idle period. Exit is by ``SIGTERM`` to itself so Serena's own shutdown runs. The
  language servers go either way — measured with ``SIGTERM``, ``SIGINT`` and a bare ``os._exit``,
  no survivor in any of them; they read their stdin and leave at end-of-file — so the survivors
  check in the test is a guard against a future exit path, not a difference between these.
"""

from __future__ import annotations

import argparse
import atexit
import functools
import logging
import os
import signal
import socket
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from junon import instances

log = logging.getLogger("junon.serve")

DEFAULT_IDLE_MINUTES = 30.0


# --- the pin -----------------------------------------------------------------------------------


def _names_pinned(tool: object, project: str, pinned_root: str) -> bool:
    """Whether `project` — a path or a registered name — means the project this instance serves."""
    try:
        if instances.normalise_root(project) == pinned_root:
            return True
    except OSError:
        pass
    agent = getattr(tool, "agent", None)
    active = agent.get_active_project() if agent is not None else None
    return active is not None and project == getattr(active, "project_name", None)


def pin(root: str | Path) -> Callable[[], None]:
    """Makes ``activate_project`` refuse every project but this one. Returns the undo.

    The override replaces the class's ``apply``, the seam ``tests/test_tool_override.py`` proves is
    the one Serena calls. The tool keeps its name and registration; asking for the pinned project
    itself still goes to upstream, whose answer is the activation message the caller expects.
    """
    from serena.tools.config_tools import ActivateProjectTool

    original = ActivateProjectTool.__dict__["apply"]
    pinned_root = instances.normalise_root(root)

    # `wraps` matters more than it looks: Serena builds the MCP tool's schema from `apply`'s
    # signature and docstring, per connection, inside the server lifespan. A replacement without
    # them made every `initialize` hang — measured: the port listened, and no session ever opened.
    @functools.wraps(original)
    def apply(self, project: str, session_id: str) -> str:  # noqa: ANN001
        if _names_pinned(self, project, pinned_root):
            return original(self, project, session_id)
        return (
            f"This JUNON is pinned to {pinned_root} and serves other sessions on it, so it will not "
            f"switch to {project!r}. To work on that project, attach a second server to it — "
            f"`junon attach --project {project}` in the host's MCP configuration — or run the "
            "session from inside it."
        )

    setattr(ActivateProjectTool, "apply", apply)

    def undo() -> None:
        setattr(ActivateProjectTool, "apply", original)

    return undo


# --- the watchdog ------------------------------------------------------------------------------


class IdleWatchdog:
    """Exits the instance once no attached session has been alive for `idle_seconds`.

    Every collaborator is injected so the decision can be tested without a process, a clock or a
    registry: `clients` says how many sessions are attached right now, `clock` says when it is,
    `on_idle` is what happens. The real ones are wired in :func:`run`.
    """

    def __init__(
        self,
        idle_seconds: float,
        clients: Callable[[], int],
        on_idle: Callable[[], None],
        clock: Callable[[], float] = time.monotonic,
        interval_seconds: float | None = None,
    ) -> None:
        self.idle_seconds = idle_seconds
        self._clients = clients
        self._on_idle = on_idle
        self._clock = clock
        # Ten checks per idle period, and never slower than once a minute or faster than twice a
        # second: precise enough that an instance is gone soon after its time, cheap enough to run.
        self.interval_seconds = (
            interval_seconds if interval_seconds is not None else min(60.0, max(0.5, idle_seconds / 10))
        )
        self._last_busy = self._clock()
        self._stopped = threading.Event()

    def tick(self) -> bool:
        """One check. Returns whether the instance should go, and calls `on_idle` if so."""
        now = self._clock()
        if self._clients() > 0:
            self._last_busy = now
            return False
        if now - self._last_busy < self.idle_seconds:
            return False
        self._on_idle()
        return True

    def run_forever(self) -> None:
        while not self._stopped.wait(self.interval_seconds):
            try:
                if self.tick():
                    return
            except Exception:  # noqa: BLE001 - a registry hiccup must not kill the instance
                log.exception("idle check failed; the instance stays up")

    def start(self) -> threading.Thread:
        thread = threading.Thread(target=self.run_forever, name="junon-idle-watchdog", daemon=True)
        thread.start()
        return thread

    def stop(self) -> None:
        self._stopped.set()


# --- the command -------------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _exit_by_signal() -> None:
    """SIGTERM to ourselves: Serena's shutdown runs, and the language servers follow (measured)."""
    instances.unpublish_instance()
    log.info("no session attached for the idle period; stopping")
    os.kill(os.getpid(), signal.SIGTERM)


def parse(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(
        prog="junon serve",
        description="Serve one project over streamable-http, shared by every session on it.",
    )
    parser.add_argument("--project", required=True, help="the project root this instance is pinned to")
    parser.add_argument("--port", type=int, default=None, help="loopback port; a free one if omitted")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--idle-minutes",
        type=float,
        default=DEFAULT_IDLE_MINUTES,
        help="exit after this long with no attached session (default %(default)s)",
    )
    # Anything else is Serena's — `--enable-web-dashboard false`, `--log-level`, contexts, modes.
    return parser.parse_known_args(argv)


def serena_argv(options: argparse.Namespace, port: int, passthrough: list[str]) -> list[str]:
    return [
        "junon",
        "start-mcp-server",
        "--transport",
        "streamable-http",
        "--host",
        options.host,
        "--port",
        str(port),
        "--project",
        instances.normalise_root(options.project),
        *passthrough,
    ]


def run(argv: list[str]) -> int:
    options, passthrough = parse(argv)
    root = instances.normalise_root(options.project)
    if not Path(root).is_dir():
        print(f"junon serve: {root} is not a directory", file=sys.stderr)
        return 2
    port = options.port if options.port is not None else _free_port()

    pin(root)
    instances.publish_instance(root, port)
    atexit.register(instances.unpublish_instance)

    me = os.getpid()
    IdleWatchdog(
        idle_seconds=options.idle_minutes * 60.0,
        clients=lambda: len(instances.live_clients(instance_pid=me)),
        on_idle=_exit_by_signal,
    ).start()

    sys.argv = serena_argv(options, port, passthrough)
    from serena.cli import top_level

    top_level()
    return 0
