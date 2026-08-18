"""Whether the halves of this installation are the same release, and what to do when they are not.

One comparison, three readers: `ide_status` tells the agent, the dashboard card tells whoever has it
open, and `ide-bridge doctor` tells whoever is at a terminal. Putting the rule here rather than in
each of them is not tidiness — the three would drift, and a product that answers "your plugin is
stale" in one place and stays silent in another has taught nobody anything.

Nothing else can make this comparison. An IDE updates its plugin without knowing a daemon exists;
`pipx` updates this package without knowing either. The daemon is the only process that sees every
peer, and it already receives each one's declared version.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

#: What to run when a plugin is behind. Named once, because a remedy that differs between surfaces
#: is a remedy a reader has to choose between.
#: No angle brackets. This string is rendered into an HTML page, and a browser parsed `<IDE>` as a
#: tag and dropped it — leaving `.app/Contents/MacOS/ installPlugins`, which is not a command.
REMEDY = (
    "Install the current plugin in each IDE named above, then restart it. From a shell, per IDE: "
    "GoLand.app/Contents/MacOS/goland installPlugins com.idebridge.jetbrains  "
    "(inside a checkout of this repository, scripts/install-jetbrains-plugin.sh does every IDE at "
    "once)"
)

_RELEASE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def release_order(left: str, right: str) -> int:
    """Orders two release numbers, and has no opinion about anything else.

    A version carrying a suffix — `0.1.0-SNAPSHOT`, which the JetBrains plugin built as for months —
    reads as *no comparison* rather than as older. Sending someone to reinstall because of a suffix
    is a worse answer than saying nothing, and calling it newer would hide a real mismatch.
    """

    def parts(value: str) -> tuple[int, int, int] | None:
        found = _RELEASE.fullmatch(value.strip())
        return (int(found[1]), int(found[2]), int(found[3])) if found else None

    a, b = parts(left), parts(right)
    if a is None or b is None:
        return 0
    return (a > b) - (a < b)


@dataclass(frozen=True, slots=True)
class Skew:
    """The verdict, in the shape every surface needs.

    `agrees` is stated even when nothing is wrong: a signal that only ever appears on failure teaches
    a reader that its absence means nothing was checked.
    """

    daemon: str
    older: tuple[str, ...]
    newer: tuple[str, ...]

    @property
    def agrees(self) -> bool:
        return not self.older and not self.newer

    @property
    def summary(self) -> str:
        if self.agrees:
            return f"daemon and every adapter at {self.daemon}"
        if self.older:
            return f"plugin(s) older than the daemon ({self.daemon}): {', '.join(self.older)}"
        return f"the daemon ({self.daemon}) is older than: {', '.join(self.newer)}"

    @property
    def remedy(self) -> str:
        if self.agrees:
            return ""
        if self.older:
            return REMEDY
        # Read from the other end the same skew has the opposite fix, and telling someone to
        # reinstall a plugin that is already ahead would send them the wrong way.
        return "restart the daemon from a current build: pnpm -r build, then ide-bridge daemon"

    def as_dict(self) -> dict[str, Any]:
        return {
            "daemon": self.daemon,
            "older": list(self.older),
            "newer": list(self.newer),
            "agrees": self.agrees,
            "summary": self.summary,
            "remedy": self.remedy,
        }


def compare(daemon_version: str, adapters: list[dict[str, Any]]) -> Skew:
    """Sorts the adapters into those behind the daemon and those ahead of it.

    Each is named as `<ide build>@<plugin version>`, not counted: a plugin is installed per IDE, so a
    number leaves the reader to work out which one to touch.
    """

    def label(adapter: dict[str, Any]) -> str:
        return f"{adapter.get('ideVersion', '?')}@{adapter.get('version', '?')}"

    older = sorted(
        {label(a) for a in adapters if release_order(str(a.get("version", "")), daemon_version) < 0}
    )
    newer = sorted(
        {label(a) for a in adapters if release_order(str(a.get("version", "")), daemon_version) > 0}
    )
    return Skew(daemon=daemon_version, older=tuple(older), newer=tuple(newer))
