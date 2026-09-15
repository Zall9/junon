"""Stopping and starting the daemon, from the command the installer wrote down.

The piece that makes one click enough. Everything else a release touches has an owner: an IDE loads
its plugin at start-up, a session starts the JUNON instance it needs. The daemon had none — it ran
whatever build it was started with until a person rebuilt and restarted it, and if it died nothing
brought it back.

What it will not do is *guess*. With no recorded command this reports that and changes nothing:
a machine that installed JUNON from `pipx` has no daemon build to start, and inventing a path there
would turn a clear "nothing to start" into a mysterious failure.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from junon import daemon_command

#: Started detached, so it belongs to nobody and outlives whoever asked for it — the same
#: re-parenting `junon attach` needs, and for the same measured reason: a host kills the descendants
#: of its MCP server when it exits, and a daemon in that tree would go with the dashboard that
#: started it.
_DETACH = (
    "import subprocess, sys\n"
    "log, cwd, *command = sys.argv[1:]\n"
    "with open(log, 'ab') as out:\n"
    "    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,"
    " start_new_session=True, cwd=cwd)\n"
    "print(child.pid)\n"
)


@dataclass(frozen=True, slots=True)
class Restart:
    """What happened, in the shape the dashboard and the report both need."""

    #: `restarted`, `started`, `no-command`, `refused`, `no-answer`
    state: str
    reason: str
    previous_pid: int | None = None
    pid: int | None = None
    version: str | None = None

    @property
    def ok(self) -> bool:
        return self.state in {"restarted", "started"}

    def as_dict(self) -> dict[str, object]:
        return {
            "state": self.state,
            "reason": self.reason,
            "previousPid": self.previous_pid,
            "pid": self.pid,
            "version": self.version,
        }


def _discovery_path() -> Path:
    override = os.environ.get("IDE_BRIDGE_DISCOVERY_FILE")
    return Path(override) if override else Path.home() / ".ide-bridge" / "discovery.json"


def running_daemon() -> tuple[int | None, str | None]:
    """The pid and endpoint the discovery file names, without trusting that it is alive."""
    try:
        payload = json.loads(_discovery_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    pid = payload.get("pid")
    endpoint = payload.get("endpoint")
    return (pid if isinstance(pid, int) else None), (endpoint if isinstance(endpoint, str) else None)


def _alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def stop(pid: int | None, timeout: float = 15.0) -> bool:
    """SIGTERM, then waits. Never SIGKILL: the daemon removes its discovery file on the way out, and
    a killed one leaves the tombstone that had a dashboard announcing a dead daemon for three weeks."""
    if not _alive(pid):
        return False
    try:
        os.kill(pid, signal.SIGTERM)  # type: ignore[arg-type]
    except OSError:
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.25)
    return not _alive(pid)


def _answers(timeout: float) -> tuple[bool, int | None]:
    """Whether a daemon is reachable now, and which pid it is. Asked of the daemon, not of a file."""
    from junon.ide_bridge_status import read_status

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = read_status()
        if status.get("status") in {"connected", "no-adapter"}:
            return True, running_daemon()[0]
        time.sleep(0.5)
    return False, running_daemon()[0]


def restart(timeout: float = 45.0) -> Restart:
    """Replaces the running daemon with the recorded build, and waits until it answers."""
    try:
        command = daemon_command.read()
    except daemon_command.Refused as refused:
        return Restart("refused", str(refused))

    if command is None:
        return Restart(
            "no-command",
            f"No daemon command is recorded at {daemon_command.path()}, so there is nothing to "
            "start. It is written by an installer running from a checkout; a machine that installed "
            "JUNON alone has no daemon build to run.",
        )

    previous, _ = running_daemon()
    stopped = stop(previous)

    logs = Path.home() / ".ide-bridge" / "daemon.log"
    try:
        logs.parent.mkdir(parents=True, exist_ok=True)
        middle = subprocess.run(
            ["python3", "-c", _DETACH, str(logs), command.directory, *command.argv],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=True,
        )
        started = int(middle.stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        return Restart("no-answer", f"The recorded daemon command could not be started: {error}", previous)

    answered, pid = _answers(timeout)
    if not answered:
        return Restart(
            "no-answer",
            f"A daemon was started (pid {started}) but did not answer within {timeout:.0f}s. Its "
            f"output is in {logs}.",
            previous,
            started,
            command.version,
        )
    return Restart(
        "restarted" if stopped else "started",
        (
            f"The daemon was replaced: pid {previous} stopped, pid {pid} now answering."
            if stopped
            else f"No daemon was running; pid {pid} started and answering."
        ),
        previous,
        pid,
        command.version,
    )
