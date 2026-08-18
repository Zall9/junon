"""What `ide_status` says about the two halves being different releases.

Nothing else says it. An IDE updates its plugin without knowing a daemon exists, `pipx` updates this
package without knowing either, and both halves read and write the same registry file — so a mismatch
is silent by construction, and surfaces later as a capability that is inexplicably absent.

`ide_status` is where it belongs because it is the call an agent is told to make first, and an agent
is how a human hears about any of this without going looking.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from junon.client import RequestFailedError
from junon.tools import IdeStatusTool, _release_order


class FakeClient:
    """Answers the two calls the version lines make."""

    def __init__(self, daemon: str, adapters: list[dict[str, Any]], fail: bool = False):
        self.daemon = daemon
        self.adapters = adapters
        self.fail = fail

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self.fail:
            raise RequestFailedError("TIMEOUT", "no answer", retryable=True)
        return {
            "bridge/getStatus": {"daemonVersion": self.daemon},
            "bridge/listAdapters": {"adapters": self.adapters},
        }[method]


def adapter(version: str, ide: str = "GO-261.23567.143") -> dict[str, Any]:
    return {"version": version, "ideVersion": ide}


@pytest.fixture
def tool() -> IdeStatusTool:
    return IdeStatusTool.__new__(IdeStatusTool)


def test_agreement_is_reported_too(tool: IdeStatusTool) -> None:
    """A line that only appears when something is wrong teaches a reader that its absence means
    nothing was checked."""
    lines = tool._version_lines(FakeClient("0.2.1", [adapter("0.2.1"), adapter("0.2.1", "PS-253")]))

    assert lines == ["  versions: daemon and every adapter at 0.2.1"]


def test_an_older_plugin_is_named_with_what_to_run(tool: IdeStatusTool) -> None:
    lines = "\n".join(tool._version_lines(FakeClient("0.2.1", [adapter("0.2.0")])))

    assert "GO-261.23567.143@0.2.0" in lines
    assert "install-jetbrains-plugin.sh" in lines
    assert "installPlugins com.idebridge.jetbrains" in lines
    # The agent must pass it on rather than quietly compensating.
    assert "Say this to the user" in lines


def test_a_newer_plugin_blames_the_daemon(tool: IdeStatusTool) -> None:
    """The same skew read from the other side. Telling someone to reinstall a plugin that is already
    ahead would send them the wrong way."""
    lines = "\n".join(tool._version_lines(FakeClient("0.2.0", [adapter("0.2.1")])))

    # The wording lives in junon.versions now; what matters is which side is named and what is asked.
    assert "the daemon (0.2.0) is older than" in lines
    assert "Rebuild and restart it" in lines
    assert "install-jetbrains-plugin.sh" not in lines


def test_no_adapter_says_so_rather_than_comparing_nothing(tool: IdeStatusTool) -> None:
    lines = tool._version_lines(FakeClient("0.2.1", []))

    assert lines == ["  versions: daemon 0.2.1, no adapter connected"]


def test_a_version_query_that_fails_never_fails_the_tool(tool: IdeStatusTool) -> None:
    """The workspaces are the answer this tool was asked for; versions are an aside."""
    assert tool._version_lines(FakeClient("0.2.1", [adapter("0.2.0")], fail=True)) == []


def test_a_suffixed_version_is_not_called_older(tool: IdeStatusTool) -> None:
    """`0.1.0-SNAPSHOT` is what this plugin built as for months. Reading it as behind would send
    someone to reinstall over a suffix; reading it as ahead would hide a real skew."""
    lines = "\n".join(tool._version_lines(FakeClient("0.2.1", [adapter("0.1.0-SNAPSHOT")])))

    assert "older plugin" not in lines
    assert "newer plugin" not in lines


def test_the_comparator_orders_releases_and_declines_the_rest() -> None:
    assert _release_order("0.2.0", "0.2.1") == -1
    assert _release_order("0.2.1", "0.2.0") == 1
    assert _release_order("0.2.1", "0.2.1") == 0
    assert _release_order("0.9.0", "0.10.0") == -1  # not string order
    assert _release_order("nightly", "0.2.1") == 0
