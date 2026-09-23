"""The agent hosts' file-tool gate: what it is, whether it is current, and putting it in place.

**One implementation.** `scripts/install-agent-gate.sh` runs this file, the dashboard's install button
calls it, and every `junon serve` instance calls it when it starts. What gets installed where is not
written here but in `integrations/agent-hosts/manifest.json`, which `ide-bridge doctor` reads too —
so the installer, its check and the doctor cannot disagree about what a complete installation is.

**Why an instance refreshes it.** Until then only two routes installed the gate: `update-all.sh` and
the install button. A `git pull` updates an editable JUNON on its own — the usual case — and left the
gate as it was; so did `pipx upgrade` and the IDE's plugin updater. Every one of those routes ends in
a `junon serve` starting on the new code, so that is where the gate follows it. Not the relay: a host
opens twenty-three of those at once, and a relay has to stay cheap.

A copy that differs is kept under `~/.ide-bridge/agent-gate-backups/` — outside every directory a host
scans for plugins — before it is replaced, and each file is written whole and renamed into place, so
a host starting at that moment never loads half a plugin. `JUNON_AGENT_GATE_AUTO=0` turns the
refresh-on-start off; the explicit routes still install.

Standard library only, on purpose: the shell script runs it with whatever `python3` is on the PATH,
outside JUNON's environment.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("junon.agent_gates")

#: Where the gates are installed — the machine's own home unless this names another. Set by the test
#: suite's floor, so that no test can write into `~/.config/opencode` or `~/.claude`.
HOME_ENV_VAR = "JUNON_AGENT_GATE_HOME"

#: `0` turns off the refresh a starting instance does. The explicit routes are not affected.
AUTO_ENV_VAR = "JUNON_AGENT_GATE_AUTO"

MANIFEST = "manifest.json"


def home() -> Path:
    override = os.environ.get(HOME_ENV_VAR)
    return Path(override) if override else Path.home()


def source_dir() -> Path | None:
    """Where this JUNON's gates are: the checkout's, or the copy packaged with a non-editable install."""
    package = Path(__file__).resolve().parent
    for candidate in (package.parents[1] / "agent-hosts", package / "resources" / "agent-hosts"):
        if (candidate / MANIFEST).is_file():
            return candidate
    return None


@dataclass(frozen=True)
class Entry:
    source: Path
    target: Path
    mode: int
    host: Path
    host_name: str


@dataclass(frozen=True)
class FileState:
    target: Path
    host_name: str
    state: str  # "current" | "differs" | "missing" | "host-absent"


@dataclass(frozen=True)
class Report:
    """What is installed, measured against this JUNON's gates."""

    source: Path | None
    files: tuple[FileState, ...] = ()
    strays: tuple[Path, ...] = ()

    @property
    def state(self) -> str:
        """`current`, `differs`, or `unavailable` when this JUNON carries no gates at all."""
        if self.source is None:
            return "unavailable"
        if self.strays or any(f.state in ("differs", "missing") for f in self.files):
            return "differs"
        return "current"

    @property
    def summary(self) -> str:
        if self.source is None:
            return "This JUNON carries no agent gates to compare against."
        stale = [f for f in self.files if f.state in ("differs", "missing")]
        if not stale and not self.strays:
            hosts = sorted({f.host_name for f in self.files if f.state == "current"})
            if not hosts:
                return "No agent host is configured on this machine."
            return f"The agent gates are this release's ({', '.join(hosts)})."
        parts = [f"{f.target.name} {'is missing' if f.state == 'missing' else 'differs'}" for f in stale]
        parts += [f"a second copy is loaded from {stray}" for stray in self.strays]
        return "Agent gates out of date: " + "; ".join(parts) + "."

    def as_dict(self) -> dict[str, object]:
        return {
            "state": self.state,
            "summary": self.summary,
            "files": [{"target": str(f.target), "host": f.host_name, "state": f.state} for f in self.files],
            "strays": [str(s) for s in self.strays],
        }


@dataclass(frozen=True)
class Installed:
    installed: tuple[Path, ...] = ()
    kept: tuple[Path, ...] = ()
    report: Report = field(default_factory=lambda: Report(source=None))


def manifest(source: Path, target_home: Path) -> tuple[list[Entry], list[Path]]:
    data = json.loads((source / MANIFEST).read_text(encoding="utf-8"))
    entries = [
        Entry(
            source=source / item["source"],
            target=target_home / item["target"],
            mode=int(item["mode"], 8),
            host=target_home / item["host"],
            host_name=item["hostName"],
        )
        for item in data["files"]
    ]
    strays = [target_home / item["path"] for item in data.get("strays", [])]
    return entries, strays


def _same(a: Path, b: Path) -> bool:
    try:
        return a.read_bytes() == b.read_bytes()
    except OSError:
        return False


def check(target_home: Path | None = None, source: Path | None = None) -> Report:
    """Compares what is installed with this JUNON's gates. Reads only."""
    target_home = target_home or home()
    source = source or source_dir()
    if source is None:
        return Report(source=None)
    entries, strays = manifest(source, target_home)
    states = []
    for entry in entries:
        if not entry.host.is_dir():
            states.append(FileState(entry.target, entry.host_name, "host-absent"))
        elif not entry.target.is_file():
            states.append(FileState(entry.target, entry.host_name, "missing"))
        elif _same(entry.source, entry.target):
            states.append(FileState(entry.target, entry.host_name, "current"))
        else:
            states.append(FileState(entry.target, entry.host_name, "differs"))
    present = tuple(stray for stray in strays if stray.is_file())
    return Report(source=source, files=tuple(states), strays=present)


def _write_whole(source: Path, target: Path, mode: int) -> None:
    """Written beside the target and renamed over it: a reader sees the old file or the new one."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_bytes(source.read_bytes())
    os.chmod(temporary, mode)
    os.replace(temporary, target)


def install(target_home: Path | None = None, source: Path | None = None) -> Installed:
    """Brings every configured host's gates to this JUNON's, keeping any copy that differed.

    Under a lock, because instances start together and each refreshes the gate: the second waits,
    then finds everything current and writes nothing.
    """
    target_home = target_home or home()
    source = source or source_dir()
    if source is None:
        return Installed(report=Report(source=None))
    entries, _ = manifest(source, target_home)
    lock_path = target_home / ".ide-bridge" / "agent-gate.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    installed: list[Path] = []
    kept: list[Path] = []
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            backups = target_home / ".ide-bridge" / "agent-gate-backups" / time.strftime("%Y%m%d-%H%M%S")
            for entry in entries:
                if not entry.host.is_dir() or _same(entry.source, entry.target):
                    continue
                if entry.target.is_file():
                    backups.mkdir(parents=True, exist_ok=True)
                    copy = backups / entry.target.name
                    copy.write_bytes(entry.target.read_bytes())
                    kept.append(copy)
                _write_whole(entry.source, entry.target, entry.mode)
                installed.append(entry.target)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return Installed(installed=tuple(installed), kept=tuple(kept), report=check(target_home, source))


def refresh_on_start() -> threading.Thread | None:
    """What a starting instance does: the same install, in the background, and one log line.

    Background because an instance must answer as soon as it can; the gate is read by agent hosts at
    their own start, so a few hundred milliseconds of lag change nothing anyone can see.
    """
    if os.environ.get(AUTO_ENV_VAR, "1") == "0":
        return None

    def run() -> None:
        try:
            result = install()
            if result.installed:
                log.warning(
                    "[JUNON] agent gates updated to this release: %s (previous copies kept: %s)",
                    ", ".join(str(p) for p in result.installed),
                    ", ".join(str(p) for p in result.kept) or "none",
                )
        except Exception as error:  # noqa: BLE001 - a gate refresh must never take an instance down
            log.warning("[JUNON] agent gates could not be refreshed: %s", error)

    thread = threading.Thread(target=run, name="junon-agent-gates", daemon=True)
    thread.start()
    return thread


# --- the command: scripts/install-agent-gate.sh -------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="install-agent-gate.sh")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="say what would happen")
    mode.add_argument("--check", action="store_true", help="exit 1 if an installed copy differs")
    options = parser.parse_args(argv)

    target_home = home()
    source = source_dir()
    if source is None:
        print("  this JUNON carries no agent gates")
        return 1

    before = check(target_home, source)
    after = before
    installed: tuple[Path, ...] = ()
    kept: tuple[Path, ...] = ()
    if not options.check and not options.dry_run:
        result = install(target_home, source)
        installed, kept, after = result.installed, result.kept, result.report

    last_host = None
    for state in before.files:
        if state.host_name != last_host:
            print(state.host_name)
            last_host = state.host_name
        if state.state == "host-absent":
            print("  not configured on this machine — skipped")
            continue
        if state.state == "current":
            print(f"  current   {state.target}")
        elif options.check:
            print(f"  {'MISSING' if state.state == 'missing' else 'DIFFERS'}   {state.target}")
        elif options.dry_run:
            print(f"  would {'install' if state.state == 'missing' else 'update'} {state.target}")
        else:
            copy = next((k for k in kept if k.name == state.target.name), None)
            if copy is not None:
                print(f"  kept      {copy}  (it differed from this release)")
            if state.target in installed:
                print(f"  installed {state.target}")
    for stray in after.strays:
        print(f"  WARNING   a second copy is loaded from {stray} — remove it")

    claude = target_home / ".claude"
    if claude.is_dir() and not options.check:
        settings = claude / "settings.json"
        registered = settings.is_file() and "junon-first-gate" in settings.read_text(errors="replace")
        if not registered:
            print("  one line left, and it is yours to run:  python3 ~/.claude/hooks/register-junon-gate.py")
    if installed:
        print("  agent hosts load these at start-up: restart opencode and Claude Code")

    if options.check:
        return 0 if before.state == "current" else 1
    return 0 if after.state == "current" else 1


if __name__ == "__main__":
    sys.exit(main())
