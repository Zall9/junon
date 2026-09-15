"""Where the command that starts the daemon is written down, so something other than a person can run it.

The daemon is the half of this product nobody owns. The JetBrains plugin only ever *connects* — no
`ProcessBuilder` anywhere in it — and only the VS Code extension can spawn one. So a daemon keeps
whatever build it started with until someone rebuilds and restarts it by hand, and a daemon that
dies stays dead: on 2026-09-15 one died when the disk filled and an IDE sat beside the corpse for
ninety minutes.

Neither the dashboard nor the plugin can *invent* the command. Only the installer knows it, because
the installer is by definition running from a checkout with a built daemon. So it writes it here,
and both of them read it. A machine with no checkout has no file, and both say so plainly instead of
failing in some obscure way.

**This file names a program that will be executed, so it is held to the same standard as the
discovery file's token** (SECURITY.md §3): refused unless it is a regular file owned by this user
and writable by nobody else. A plugin that runs a command out of a world-writable file is a local
privilege escalation, and this must not become one.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

#: Beside the discovery file, because they describe the same daemon from two directions.
ENV_VAR = "IDE_BRIDGE_DAEMON_COMMAND_FILE"


def path() -> Path:
    override = os.environ.get(ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "daemon.json"


@dataclass(frozen=True, slots=True)
class DaemonCommand:
    """How to start a daemon, and which build it is."""

    #: The full argument vector, node first.
    argv: tuple[str, ...]
    #: Where to run it, so relative paths inside the bundle resolve.
    directory: str
    #: What the checkout called itself when this was written — for reporting, never for deciding.
    version: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {"argv": list(self.argv), "directory": self.directory, "version": self.version}


class Refused(RuntimeError):
    """The file exists and will not be used, with the reason a reader can act on."""


def record(argv: list[str] | tuple[str, ...], directory: str | Path, version: str | None = None) -> Path:
    """Writes the command down, readable and writable by this user only."""
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = DaemonCommand(tuple(str(a) for a in argv), str(directory), version).as_dict()
    # Written whole then renamed, so a reader never sees half a command; and created 0600 from the
    # start rather than chmod-ed afterwards, which leaves a window where it is world-readable.
    temporary = target.with_suffix(".json.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.chmod(temporary, 0o600)
    temporary.replace(target)
    return target


def read() -> DaemonCommand | None:
    """The recorded command, or `None` when there is none. Raises [Refused] when there is one that
    cannot be trusted — silence there would be the dangerous answer."""
    target = path()
    try:
        info = target.stat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise Refused(f"{target} could not be read: {error.strerror}") from error

    if not stat.S_ISREG(info.st_mode):
        raise Refused(f"{target} is not a regular file")
    if info.st_uid != os.getuid():
        raise Refused(f"{target} is owned by uid {info.st_uid}, not by you — refusing to run it")
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise Refused(
            f"{target} is writable by other users, so what it names could have been chosen by "
            "somebody else — refusing to run it. Fix with: chmod 600 " + str(target)
        )

    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        argv = [str(item) for item in payload["argv"]]
        directory = str(payload["directory"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Refused(f"{target} is not a usable daemon command: {error}") from error
    if not argv:
        raise Refused(f"{target} names no command")
    return DaemonCommand(tuple(argv), directory, payload.get("version"))
