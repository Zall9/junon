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

#: What to do when a plugin is behind. Named once, because a remedy that differs between surfaces is
#: a remedy a reader has to choose between.
#:
#: No `installPlugins` here: it installs a plugin that is **absent** and refuses to replace one that
#: is present — measured, exit code 0 and nothing written — so naming it sent people to a command that
#: does nothing. No angle brackets either: this string is rendered into an HTML page, and a browser
#: parsed `<IDE>` as a tag and dropped it.
REMEDY = (
    "Install the current plugin in each IDE named above, then restart it. Quit the IDE first — a "
    "running one cannot be written to. Either press Install now on this dashboard, or run "
    "scripts/install-jetbrains-plugin.sh from a checkout of this repository, which does every IDE at "
    "once."
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


#: What to run when the daemon is the stale half. It is rebuilt and restarted, not reinstalled.
DAEMON_REMEDY = (
    "The daemon is running an older build than this JUNON. Rebuild and restart it: pnpm -r build, "
    "then stop the running daemon and start it again — a rebuild alone changes nothing, since the "
    "process keeps the code it was started with."
)


@dataclass(frozen=True, slots=True)
class Skew:
    """The verdict, in the shape every surface needs.

    Three peers, not two. The daemon used to be the reference, which made a stale daemon
    unmeasurable: everything was compared *to* it, so it was correct by construction. `consumer` is
    this JUNON's own version — known without asking anyone — and it is what makes "the daemon is the
    old one here" sayable at all.

    `agrees` is stated even when nothing is wrong: a signal that only appears on failure teaches a
    reader that its absence means nothing was checked.
    """

    daemon: str
    older: tuple[str, ...]
    newer: tuple[str, ...]
    consumer: str = ""

    @property
    def daemon_is_stale(self) -> bool:
        """Whether this JUNON is from a later release than the daemon it is talking to."""
        return bool(self.consumer) and release_order(self.daemon, self.consumer) < 0

    @property
    def agrees(self) -> bool:
        return not self.older and not self.newer and not self.daemon_is_stale

    @property
    def summary(self) -> str:
        if self.agrees:
            return f"daemon and every adapter at {self.daemon}"
        parts: list[str] = []
        if self.daemon_is_stale:
            parts.append(f"the daemon ({self.daemon}) is older than this JUNON ({self.consumer})")
        if self.older:
            parts.append(
                f"plugin(s) older than the daemon ({self.daemon}): {', '.join(self.older)}"
            )
        if self.newer:
            parts.append(f"the daemon ({self.daemon}) is older than: {', '.join(self.newer)}")
        return "; ".join(parts)

    @property
    def remedy(self) -> str:
        if self.agrees:
            return ""
        parts: list[str] = []
        # The daemon first when it is behind: updating a plugin against a stale daemon leaves the
        # skew in place, and the person would be back here.
        if self.daemon_is_stale or self.newer:
            parts.append(DAEMON_REMEDY)
        if self.older:
            parts.append(REMEDY)
        return " ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "daemon": self.daemon,
            "consumer": self.consumer,
            "older": list(self.older),
            "newer": list(self.newer),
            "daemonStale": self.daemon_is_stale,
            "agrees": self.agrees,
            "summary": self.summary,
            "remedy": self.remedy,
        }


def compare(
    daemon_version: str,
    adapters: list[dict[str, Any]],
    consumer_version: str = "",
) -> Skew:
    """Sorts the peers around the daemon, and measures the daemon against the consumer.

    Each adapter is named as `<ide build>@<plugin version>`, not counted: a plugin is installed per
    IDE, so a number leaves the reader to work out which one to touch.
    """

    def label(adapter: dict[str, Any]) -> str:
        return f"{adapter.get('ideVersion', '?')}@{adapter.get('version', '?')}"

    older = sorted(
        {label(a) for a in adapters if release_order(str(a.get("version", "")), daemon_version) < 0}
    )
    newer = sorted(
        {label(a) for a in adapters if release_order(str(a.get("version", "")), daemon_version) > 0}
    )
    return Skew(
        daemon=daemon_version,
        older=tuple(older),
        newer=tuple(newer),
        consumer=consumer_version,
    )


#: What to do when this machine is behind the published release. Deliberately not `REMEDY`: nothing
#: in this product downloads a release, so the first step is the person's, not the button's.
PUBLISHED_REMEDY = (
    "Update the checkout and rebuild: git pull, then pnpm -r build, then restart the daemon and press "
    "Install now. The Install button installs the plugin built from this checkout and never downloads "
    "one, so pulling first is what makes it the published release rather than the one you already had. "
    "An IDE configured with the plugin repository will also offer the update itself."
)


@dataclass(frozen=True, slots=True)
class Published:
    """What the plugin repository advertises, measured against what is on this machine.

    Separate from `Skew`, because the two questions are independent and the reassuring one is the
    easier to answer: every half here can agree at 0.2.1 — nothing at all to report locally — while
    0.2.4 has been published for a week.

    `reason` carries the case where the question could not be asked. It must never render as "up to
    date": an offline laptop that reports "you are current" is worse than one that reports nothing,
    because the reader stops looking.
    """

    latest: str = ""
    behind: tuple[str, ...] = ()
    reason: str = ""

    @property
    def asked(self) -> bool:
        """Whether an answer came back at all."""
        return bool(self.latest)

    @property
    def up_to_date(self) -> bool:
        return self.asked and not self.behind

    @property
    def summary(self) -> str:
        if not self.asked:
            return self.reason or "The published release could not be established."
        if self.up_to_date:
            return f"This machine is on the latest published release ({self.latest})."
        return f"Release {self.latest} is published. Older here: {', '.join(self.behind)}."

    @property
    def remedy(self) -> str:
        return PUBLISHED_REMEDY if self.asked and self.behind else ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "latest": self.latest,
            "behind": list(self.behind),
            "asked": self.asked,
            "upToDate": self.up_to_date,
            "summary": self.summary,
            "remedy": self.remedy,
        }


def published_gap(latest: str, local: dict[str, str], reason: str = "") -> Published:
    """Which halves on this machine are older than the published release.

    Named rather than counted, for the reason `compare` names adapters: "two things are behind" makes
    the reader go and find out which two.
    """
    if not latest:
        return Published(reason=reason)
    behind = tuple(
        f"{name} ({version})"
        for name, version in sorted(local.items())
        if version and release_order(version, latest) < 0
    )
    return Published(latest=latest, behind=behind)
