"""What Serena is installed here, and what the index says exists — asked only when someone asks.

JUNON is composed onto an unmodified Serena, which means Serena's releases arrive from a channel that
knows nothing about JUNON. That has already broken this machine twice: 1.5.3 changed the signature of
`run_in_thread` and JUNON's override killed the agent at start-up, and a project config written by 1.7
made 26 of 27 projects unloadable under the 1.5.3 that was actually installed.

Neither break was visible before it happened, and neither was visible in a version number alone. So
this module answers the first half of the question — is there a newer Serena — and
`serena_upgrade.py` answers the half that matters: whether taking it leaves a working installation.

Same terms as the plugin repository check in `published.py`, for the same reasons: only when asked, a
GET of a public index, no identifier, and "could not ask" is never reported as "up to date".
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from junon.versions import release_order

#: The public index entry for the package this composes onto.
DEFAULT_URL = "https://pypi.org/pypi/serena-agent/json"

#: Bounded: this runs while a person waits at a terminal.
TIMEOUT_SECONDS = 10.0

#: The interpreter of the pipx venv that owns the installation. Asked rather than assumed, because a
#: version read from *this* process would describe whichever Python happened to run the script.
PIPX_VENV_PYTHON = Path.home() / ".local/pipx/venvs/serena-agent/bin/python"


@dataclass(frozen=True, slots=True)
class SerenaVersions:
    """Installed against published, with the reason when the second could not be established."""

    installed: str = ""
    latest: str = ""
    reason: str = ""

    @property
    def asked(self) -> bool:
        return bool(self.latest)

    @property
    def behind(self) -> bool:
        return self.asked and bool(self.installed) and release_order(self.installed, self.latest) < 0

    @property
    def summary(self) -> str:
        if not self.installed:
            return "No pipx installation of serena-agent was found."
        if not self.asked:
            return f"Serena {self.installed} is installed. {self.reason}"
        if self.behind:
            return f"Serena {self.latest} is published; {self.installed} is installed."
        return f"Serena {self.installed} is installed, and is the published release."


def installed_version(python: Path = PIPX_VENV_PYTHON) -> str:
    """The version in the venv that actually serves JUNON, or "" if there is none.

    Read through that interpreter rather than through this one: JUNON is installed *into* Serena's
    pipx venv as an editable package, so the two live together and only that interpreter can say
    which Serena is really in front of it.
    """
    if not python.exists():
        return ""
    try:
        done = subprocess.run(
            [str(python), "-c", "import importlib.metadata as m; print(m.version('serena-agent'))"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def latest_release(url: str = DEFAULT_URL, timeout: float = TIMEOUT_SECONDS) -> tuple[str, str]:
    """The version the index advertises, or ("", why not). Never raises."""
    try:
        with urllib.request.urlopen(  # noqa: S310 - a fixed https URL, not caller-supplied
            urllib.request.Request(url, method="GET"), timeout=timeout
        ) as response:
            payload = json.loads(response.read(2_000_000).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError) as error:
        return "", f"Could not reach the package index: {error}"
    version = str((payload.get("info") or {}).get("version") or "")
    if not version:
        return "", "The package index answered, but advertised no version."
    return version, ""


def check(url: str = DEFAULT_URL) -> SerenaVersions:
    """Both halves of the question, in one call."""
    latest, reason = latest_release(url)
    return SerenaVersions(installed=installed_version(), latest=latest, reason=reason)
