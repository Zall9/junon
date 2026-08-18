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
import subprocess
from dataclasses import dataclass
from pathlib import Path

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
        """Whether this went as well as it could.

        A running IDE is not a failure: it is a reason, stated in the answer, and the person can act
        on it. Counting it as one made the toast announce "Not installed" over two IDEs that had just
        been updated — and the title is what gets read.
        """
        unexplained = set(self.failed) - set(self.running)
        return bool(self.installed) and not unexplained

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


def plugins_directory(ide: str) -> Path | None:
    base = Path.home() / "Library/Application Support/JetBrains"
    for directory in sorted(base.glob(f"{ide.replace(' ', '')}*/plugins")):
        return directory
    return None


def install(timeout: float = 300.0) -> InstallOutcome:
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

    for name, launcher in installed_ides():
        before = installed_version(name)
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
