"""Asking the plugin repository what the latest release is — only when someone asks it to.

Everything else in this product compares what is on this machine against what is also on this
machine: the plugins against the daemon, the daemon against JUNON, the daemon against the CLI. That
catches every skew *after* one half has been updated, and catches nothing at all before. Three halves
sitting at 0.2.1 agree with each other, and agreement is what they report, however long 0.2.4 has
been published.

This is the one place in the product that reaches the network, and the terms are the point:

* **Only when asked.** No timer, no check at start-up, no "while we're here". It runs from a button
  or from `ide-bridge doctor --check-updates`. If nobody asks, nothing leaves the machine.
* **A GET of a public file** — the same file an IDE polls for plugin updates — with no query string,
  no identifier, and nothing about this installation in the request. The repository learns that
  somebody fetched a public URL, which is what a repository is for.
* **It reads a version.** Nothing is downloaded, nothing is installed, nothing is written.
* **It never fails its caller.** Offline, a proxy, a captive portal: the answer is "could not ask",
  never an exception that takes down the page or the doctor run it sits inside.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from dataclasses import dataclass

from junon.versions import Published, published_gap

#: The repository the IDEs are pointed at, asked the same way they ask it.
DEFAULT_URL = "https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml"

#: Bounded on purpose: this runs while a page waits for it.
TIMEOUT_SECONDS = 10.0

_VERSION = re.compile(r'version="(\d+\.\d+\.\d+)"')


@dataclass(frozen=True, slots=True)
class Advertised:
    """What the repository said, or why it could not be asked. Never both, never neither."""

    version: str = ""
    reason: str = ""

    @property
    def reachable(self) -> bool:
        return bool(self.version)


def latest_release(url: str = DEFAULT_URL, timeout: float = TIMEOUT_SECONDS) -> Advertised:
    """The release the plugin repository advertises.

    For anyone comparing this against a push they just made: the host answers
    `cache-control: max-age=300`, so a new release can take minutes to appear here — measured at 124
    seconds on 0.2.2, and a cache-busting query string does not shorten it. Seeing the previous
    number shortly after a release is the cache, not a failed release.
    """
    try:
        with urllib.request.urlopen(  # noqa: S310 - a fixed https URL, not caller-supplied
            urllib.request.Request(url, method="GET"), timeout=timeout
        ) as response:
            body = response.read(64_000).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError) as error:
        return Advertised(reason=f"Could not reach the plugin repository: {error}")

    found = _VERSION.search(body)
    if not found:
        return Advertised(reason="The plugin repository answered, but advertised no release.")
    return Advertised(version=found.group(1))


def local_releases() -> dict[str, str]:
    """Every version on this machine worth measuring against the published one.

    Each source is asked separately and none of them is allowed to sink the answer. A machine with no
    daemon running still has plugins on disk and a JUNON of its own, and reporting "unknown" for the
    whole machine because one process is down would hide the update from exactly the person who has
    not started anything yet.
    """
    from junon.client import JUNON_VERSION

    local: dict[str, str] = {"JUNON": JUNON_VERSION}

    try:
        from junon.ide_bridge_status import read_status

        daemon = read_status().get("daemonVersion")
        if isinstance(daemon, str) and daemon:
            local["the daemon"] = daemon
    except Exception:  # noqa: BLE001 - "could not ask the daemon" is an answer, not a failure
        pass

    try:
        from junon.update_action import installed_ides, installed_version

        for name, _ in installed_ides():
            if version := installed_version(name):
                local[name] = version
    except Exception:  # noqa: BLE001 - same: a missing plugin directory is not an error here
        pass

    return local


def check(url: str = DEFAULT_URL) -> Published:
    """The whole question in one call: what is published, and what here is older than it."""
    advertised = latest_release(url)
    return published_gap(advertised.version, local_releases(), reason=advertised.reason)
