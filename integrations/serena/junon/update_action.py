"""Installing the current plugin into the IDEs, from the dashboard, without becoming a back door.

The dashboard is a page on `127.0.0.1`, and any site a browser visits can post to a loopback port
without the person noticing. A button that runs an installer is therefore a door, and it is worth
saying plainly what keeps it shut:

* **A token this process minted at start-up**, sent in a header. A cross-site form can post to a
  loopback URL, but it cannot read the page to learn the token, and it cannot set a custom header —
  that combination is what makes the request unforgeable rather than merely inconvenient.
* **An `Origin` check.** A request from any page other than this dashboard is refused by name.
* **No parameters.** The route takes nothing from the caller: it runs one fixed command with a fixed
  argument. There is no path, no version and no flag to smuggle, so the worst a stolen token buys is
  the same installation the button offers.
* **The IDE's own launcher**, not a shell string. `installPlugins` resolves the plugin from the
  repositories the IDE already trusts; nothing here interpolates user input into a command line.

What it cannot do is install into an IDE that is running — the platform reads plugins at start-up —
which is why the answer says what to do next rather than claiming success.
"""

from __future__ import annotations

import secrets
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PLUGIN_ID = "com.idebridge.jetbrains"

#: Minted per process. A token that outlived the page it belongs to would be a credential on disk.
SESSION_TOKEN = secrets.token_urlsafe(32)

_IDE_LAUNCHERS = {
    "GoLand": "goland",
    "PhpStorm": "phpstorm",
    "PyCharm": "pycharm",
    "IntelliJ IDEA": "idea",
}


@dataclass(frozen=True, slots=True)
class InstallOutcome:
    """What actually happened, per IDE, and why — which is not the same question.

    Each IDE is recorded with whether it was running, because that single fact explains both of the
    unhappy outcomes: a launcher refuses to write into a live instance, and it exits quietly when it
    has nothing to do. Reporting "failed, run it by hand" when the cause is known would send someone
    to a terminal to rediscover it.
    """

    installed: tuple[str, ...]
    unchanged: tuple[str, ...]
    failed: tuple[str, ...]
    running: tuple[str, ...]

    @property
    def ok(self) -> bool:
        """Whether there is nothing left for the person to do.

        A running IDE is not a failure: it is a reason, stated in the answer, and the person can act
        on it. Counting it as one made the toast announce "Not installed" over two IDEs that had just
        been updated — and the title is what gets read.

        `bool(self.installed)` used to be required, which made the best possible outcome — every IDE
        already carrying this exact plugin — report as not-ok, and the card headed it "Not installed".
        Seen on 2026-09-15, twice in an hour. Nothing to do is the definition of ok, not the absence
        of it.

        A running IDE that still needs the plugin was considered for this verdict and deliberately
        left out of it: the measurement above is that turning an open third IDE into a failed run
        mislabels two successful ones. What remains to be done is said by [title] and [next_step],
        which is where a person reads it, rather than by flipping a boolean that also travels to
        callers with no headline to write.
        """
        unexplained = set(self.failed) - set(self.running)
        return not unexplained and bool(self.installed or self.unchanged)

    @property
    def title(self) -> str:
        """The headline, decided here rather than from a boolean the page has to interpret.

        "Installed" and "Not installed" cannot between them describe *already current*, which is the
        ordinary answer to pressing this button twice — and the one that read as a failure.
        """
        if set(self.failed) - set(self.running):
            return "Install failed"
        if self.running and self.installed:
            return "Partly installed"
        if self.running:
            return "Not installed"
        if self.installed:
            return "Installed"
        if self.unchanged:
            return "Already current"
        return "Nothing to install"

    def _split(self, names: tuple[str, ...]) -> tuple[list[str], list[str]]:
        live = [name for name in names if name in self.running]
        idle = [name for name in names if name not in self.running]
        return live, idle

    @property
    def next_step(self) -> str:
        """What to do, with the cause attached rather than a generic instruction."""
        parts: list[str] = []

        if self.installed:
            live, idle = self._split(self.installed)
            if live:
                parts.append(
                    f"Installed into {', '.join(live)} — restart "
                    f"{'them' if len(live) > 1 else 'it'}, since a plugin is read at start-up."
                )
            if idle:
                parts.append(
                    f"Installed into {', '.join(idle)}, which will load it when you next open "
                    f"{'them' if len(idle) > 1 else 'it'}."
                )

        blocked, current = self._split(self.failed + self.unchanged)
        if blocked:
            parts.append(
                f"{', '.join(blocked)} could not be written to because "
                f"{'they are' if len(blocked) > 1 else 'it is'} running: quit "
                f"{'them' if len(blocked) > 1 else 'it'} and press this again."
            )
        if current:
            parts.append(f"{', '.join(current)} already had the current plugin.")

        if not parts:
            parts.append("Nothing to install.")
        parts.append(
            "Then check it took: this card should say the daemon and every adapter are at the same "
            "version, and `ide_status` should tell an agent the same. If it still names an older "
            "plugin, that IDE has not been restarted."
        )
        return " ".join(parts)


def record_daemon_command() -> Path | None:
    """Writes down how to start the daemon, when this machine has one to start.

    Done by the installer because the installer is the only party that knows: it runs from a
    checkout, where the daemon has been built. The dashboard and the IDE plugin then have something
    to read instead of a path to guess (`docs/SELF_HEALING_PLAN.md` §3).
    """
    from junon import daemon_command

    root = Path(__file__).resolve().parents[3]
    binary = root / "packages" / "cli" / "dist" / "bin.js"
    node = shutil.which("node")
    if node is None or not binary.is_file():
        return None
    version = None
    try:
        version = (root / "VERSION").read_text(encoding="utf-8").strip() or None
    except OSError:
        pass
    return daemon_command.record([node, str(binary), "daemon"], root, version)


def verify() -> dict[str, Any]:
    """Checks the end state rather than describing the steps that were taken.

    "I did four things, good luck" is what this button used to say. What a person wants to know is
    whether it worked, and the answer is available: what each IDE holds on disk, what the daemon
    reports, and whether an adapter is attached. Asked here, after the work, so the sentence is a
    measurement and not a hope.
    """
    from junon.ide_bridge_status import read_status

    wanted = artefact_version(artefact())
    on_disk = {name: installed_version(name) for name, _ in installed_ides()}
    behind = [name for name, version in on_disk.items() if wanted is not None and version != wanted]

    status = read_status()
    versions = status.get("versions") or {}
    daemon_version = status.get("daemonVersion")

    if behind:
        sentence = f"Not done: {', '.join(behind)} still has an older plugin on disk."
        agrees = False
    elif status.get("status") == "connected" and versions.get("agrees"):
        sentence = f"Verified: {versions.get('summary')}, with an IDE attached. Nothing left to do."
        agrees = True
    elif status.get("status") == "connected":
        sentence = f"Not done: {versions.get('summary')}."
        agrees = False
    elif status.get("status") in {"no-adapter", "daemon-unreachable", "no-daemon"}:
        # The ordinary state a moment after a click that quit the IDEs: both halves on disk are
        # current, the daemon answers, and nothing is attached because nothing is open yet.
        sentence = (
            f"The plugin and the daemon are both at {wanted or 'the installed version'}"
            f"{'' if daemon_version in (None, wanted) else f' (the daemon reports {daemon_version})'}. "
            "Reopen your IDEs and they will attach on their own; there is nothing else to do."
        )
        agrees = daemon_version in (None, wanted)
    else:
        sentence = f"Could not verify: {status.get('reason') or status.get('status')}."
        agrees = False

    return {
        "agrees": agrees,
        "sentence": sentence,
        "wanted": wanted,
        "onDisk": on_disk,
        "daemonVersion": daemon_version,
    }


def apply_release(
    quit_running: bool = False,
    restart_daemon: Callable[[], Any] | None = None,
    check: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Everything a click should do, in one place, and what came of each part.

    The two routes used to each assemble their own answer from an `InstallOutcome`, which is how the
    plugin came to be the only half a click reached: adding a step meant remembering to add it
    twice. There is one sequence now, and both routes return it.

    The last two steps are parameters because they act on the machine: the first version of this
    was called by unit tests that then stopped and restarted the developer's own daemon, which took
    a 0.4 s test to 33 s and would have taken somebody's working IDE down with it.
    """
    from junon import daemon_control

    restart_daemon = restart_daemon or daemon_control.restart
    check = check or verify

    outcome = install(quit_running=quit_running)
    record_daemon_command()
    stopped = refresh_instances()
    daemon = restart_daemon()

    told = outcome.next_step
    if stopped:
        told += (
            f" Also stopped {len(stopped)} shared JUNON instance(s) — "
            f"{', '.join(stopped)} — so every open session moves to this release at its next call, "
            "with nothing to restart."
        )
    told += f" {daemon.reason}"
    checked = check()
    told += f" {checked['sentence']}"
    return {
        "ok": outcome.ok and daemon.state != "refused" and checked["agrees"],
        "verified": checked,
        "title": outcome.title,
        "installed": list(outcome.installed),
        "unchanged": list(outcome.unchanged),
        "failed": list(outcome.failed),
        "running": list(outcome.running),
        "instancesStopped": list(stopped),
        "daemon": daemon.as_dict(),
        "next": told,
    }


def refresh_instances() -> tuple[str, ...]:
    """Stops every shared JUNON instance, so live sessions land on the code just installed.

    Installing changes files; a running process keeps what it imported. Every session on this
    machine would otherwise go on using the previous release until its instance idled out — which is
    the whole of "why did the update not take", asked three times in one day.

    Stopping a busy instance became reasonable in 0.3.7: a relay follows its instance and reconnects
    on its next call. Before that this would have ended those sessions, which is why the button did
    not do it.
    """
    from junon import instances

    stopped, _ = instances.stop_free(including_busy=True)
    return tuple(instance.root for instance in stopped)


def installed_ides() -> list[tuple[str, Path]]:
    """The IDEs on this machine whose launcher can install a plugin."""
    found: list[tuple[str, Path]] = []
    for directory in (Path.home() / "Applications", Path("/Applications")):
        for name, launcher in _IDE_LAUNCHERS.items():
            path = directory / f"{name}.app/Contents/MacOS/{launcher}"
            if path.is_file() and not any(name == existing for existing, _ in found):
                found.append((name, path))
    return found


def is_running(ide: str) -> bool:
    result = subprocess.run(
        ["pgrep", "-f", f"{ide}.app/Contents/MacOS"], capture_output=True, text=True
    )
    return result.returncode == 0


def installed_version(ide: str) -> str | None:
    """What that IDE has on disk right now, read from the jar rather than assumed."""
    import re
    import zipfile

    base = Path.home() / "Library/Application Support/JetBrains"
    for directory in base.glob(f"{ide.replace(' ', '')}*/plugins/ide-bridge-jetbrains/lib"):
        for jar in directory.glob("*.jar"):
            try:
                with zipfile.ZipFile(jar) as archive:
                    descriptor = archive.read("META-INF/plugin.xml").decode("utf-8", "replace")
            except (OSError, KeyError, zipfile.BadZipFile):
                continue
            found = re.search(r"<version>([^<]+)", descriptor)
            if found:
                return found.group(1)
    return None


def artefact() -> Path | None:
    """The newest plugin zip this machine has, or nothing.

    A checkout carries one; a `pipx` copy does not, and for that case there is no honest local
    install — the IDE's own updater is what can upgrade, which the answer says rather than pretending.
    """
    root = Path(__file__).resolve().parents[3]
    candidates = [
        *(root / "dist").glob("ide-bridge-jetbrains-*.zip"),
        *(root / "jetbrains-plugin/build/distributions").glob("ide-bridge-jetbrains-*.zip"),
    ]
    if not candidates:
        return None

    def release(path: Path) -> tuple[int, ...]:
        digits = path.stem.rsplit("-", 1)[-1].split(".")
        return tuple(int(part) for part in digits if part.isdigit())

    return max(candidates, key=release)


def artefact_version(zip_path: Path | None) -> str | None:
    """The version inside the artefact, read from its descriptor rather than from its filename.

    The filename is written by the build and is nearly always right; "nearly" is the problem. This
    is compared against what an IDE has on disk to decide whether there is anything to install, and
    both sides of that comparison must be the same measurement — `installed_version` reads
    `plugin.xml`, so this does too.
    """
    import re
    import zipfile

    if zip_path is None:
        return None
    try:
        with zipfile.ZipFile(zip_path) as archive:
            name = next(
                (n for n in archive.namelist() if n.endswith("lib/ide-bridge-jetbrains") or n.endswith(".jar")),
                None,
            )
            if name is None:
                return None
            with archive.open(name) as raw, zipfile.ZipFile(raw) as jar:
                descriptor = jar.read("META-INF/plugin.xml").decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile, ValueError):
        return None
    found = re.search(r"<version>([^<]+)", descriptor)
    return found.group(1) if found else None


def plugins_directory(ide: str) -> Path | None:
    base = Path.home() / "Library/Application Support/JetBrains"
    for directory in sorted(base.glob(f"{ide.replace(' ', '')}*/plugins")):
        return directory
    return None


def ask_to_quit(ide: str, timeout: float = 45.0) -> bool:
    """Asks an IDE to quit, the way its menu does, and waits for it to be gone.

    Never a signal: `kill` denies the IDE its save-and-shutdown path, and a JetBrains IDE that dies
    mid-write leaves indexes to rebuild. The trade is that this can be refused — a modal dialog, an
    unsaved editor asking a question — which is a legitimate answer and is reported as such.
    """
    import time

    subprocess.run(
        ["osascript", "-e", f'tell application "{ide}" to quit'],
        capture_output=True,
        text=True,
        timeout=30,
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not is_running(ide):
            return True
        time.sleep(1.5)
    return not is_running(ide)


def install(timeout: float = 300.0, quit_running: bool = False) -> InstallOutcome:
    """Puts the current plugin in place, and reports what changed rather than what exited zero.

    The archive is unpacked directly, because the IDE's `installPlugins` refuses to replace a plugin
    that is already there — measured: *"already installed"*, exit code 0, nothing written. It is still
    used when an IDE has no plugin at all, where it resolves the artefact from the repository itself.
    """
    import shutil
    import zipfile

    zip_path = artefact()
    installed: list[str] = []
    unchanged: list[str] = []
    failed: list[str] = []
    running: list[str] = []

    wanted = artefact_version(zip_path)

    for name, launcher in installed_ides():
        before = installed_version(name)
        # Asked before anything about running: an IDE that already holds this exact plugin has
        # nothing to write, so whether it is open is beside the point. Asked the other way round —
        # which is how this shipped — it told someone to quit PhpStorm to install a plugin PhpStorm
        # already had, and the card headed the whole answer "Not installed". Seen on 2026-09-15.
        if wanted is not None and before == wanted:
            unchanged.append(name)
            continue
        if is_running(name) and quit_running:
            # Asked, not killed — and if it declines, that is the answer, not a reason to insist.
            ask_to_quit(name)
        if is_running(name):
            # Replacing a jar under a live IDE is how you get a half-loaded plugin; the platform
            # reads them at start-up and holds them open.
            running.append(name)
            failed.append(name)
            continue

        directory = plugins_directory(name)
        if zip_path is not None and directory is not None:
            try:
                target = directory / "ide-bridge-jetbrains"
                if target.exists():
                    shutil.rmtree(target)
                with zipfile.ZipFile(zip_path) as archive:
                    archive.extractall(directory)
            except (OSError, zipfile.BadZipFile):
                failed.append(name)
                continue
        else:
            try:
                completed = subprocess.run(
                    [str(launcher), "installPlugins", PLUGIN_ID],
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
            except (OSError, subprocess.SubprocessError):
                failed.append(name)
                continue
            if completed.returncode != 0:
                failed.append(name)
                continue

        after = installed_version(name)
        if after != before:
            installed.append(name)
        else:
            unchanged.append(name)

    return InstallOutcome(tuple(installed), tuple(unchanged), tuple(failed), tuple(running))
