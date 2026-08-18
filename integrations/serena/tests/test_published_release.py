"""The release check: what it asks, what it refuses to claim, and what it must never do on its own.

This is the only part of the product that reaches the network, so the tests are as much about the
calls that must *not* happen as about the one that may. Three properties are load-bearing:

* nothing fetches unless a person asked — no poll, no import, no status call;
* a check that could not reach the repository never renders as "up to date";
* the check is behind the same token as the install, because it makes this process talk outward.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from typing import Any
from unittest.mock import MagicMock

import pytest
from flask.testing import FlaskClient

from junon.dashboard import JunonDashboardAPI
from junon.published import Advertised, latest_release
from junon.versions import published_gap

REPOSITORY = """<?xml version="1.0" encoding="UTF-8"?>
<plugins>
  <plugin id="com.idebridge.jetbrains" url="https://example.invalid/ide-bridge.zip" version="0.2.9">
    <idea-version since-build="243" />
  </plugin>
</plugins>
"""


class _Response:
    """Enough of `urlopen`'s return value to be read once inside a `with`."""

    def __init__(self, body: str) -> None:
        self._body = body.encode()

    def read(self, _limit: int | None = None) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None


@pytest.fixture
def repository(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Serves the repository file, and records every URL that was actually fetched."""
    asked: list[str] = []

    def urlopen(request: Any, **_: Any) -> _Response:
        asked.append(request.full_url)
        return _Response(REPOSITORY)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return asked


class TestAskingTheRepository:
    def test_the_advertised_release_is_read(self, repository: list[str]) -> None:
        assert latest_release().version == "0.2.9"

    def test_nothing_about_this_machine_is_sent(self, repository: list[str]) -> None:
        """A plain GET of a public file. No query string is where "no identifier" starts."""
        latest_release()

        assert "?" not in repository[0]

    def test_being_offline_is_an_answer_not_an_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A laptop on a train must not take down the page that asked."""

        def refuse(*_: object, **__: object) -> None:
            raise urllib.error.URLError("no route to host")

        monkeypatch.setattr(urllib.request, "urlopen", refuse)

        answer = latest_release()

        assert not answer.reachable
        assert "Could not reach" in answer.reason

    def test_an_answer_without_a_version_is_not_an_answer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A captive portal returns 200 and a login page. That is not a release number."""
        monkeypatch.setattr(
            urllib.request, "urlopen", lambda *_, **__: _Response("<html>Sign in</html>")
        )

        assert not latest_release().reachable


class TestTheVerdict:
    def test_the_halves_that_are_behind_are_named(self) -> None:
        gap = published_gap("0.2.9", {"the daemon": "0.2.3", "JUNON": "0.2.9", "GoLand": "0.2.1"})

        assert gap.behind == ("GoLand (0.2.1)", "the daemon (0.2.3)")
        assert not gap.up_to_date

    def test_everything_current_is_said_plainly(self) -> None:
        gap = published_gap("0.2.9", {"the daemon": "0.2.9", "JUNON": "0.2.9"})

        assert gap.up_to_date
        assert "0.2.9" in gap.summary
        assert gap.remedy == ""

    def test_a_check_that_could_not_run_never_reads_as_current(self) -> None:
        """The failure this test exists for: an offline machine told it is up to date stops looking."""
        gap = published_gap("", {"JUNON": "0.2.3"}, reason="Could not reach the plugin repository.")

        assert not gap.up_to_date
        assert not gap.asked
        assert gap.summary == "Could not reach the plugin repository."

    def test_something_newer_here_than_published_is_not_a_complaint(self) -> None:
        """A checkout mid-release is ahead of the repository. That is normal and says nothing."""
        gap = published_gap("0.2.3", {"JUNON": "0.2.4", "the daemon": "0.2.4"})

        assert gap.up_to_date

    def test_the_remedy_does_not_promise_a_download(self) -> None:
        """The Install button installs what this checkout built. Saying otherwise sends someone to
        press it and wonder why the version did not move."""
        gap = published_gap("0.2.9", {"JUNON": "0.2.3"})

        assert "git pull" in gap.remedy


class TestOnlyWhenAsked:
    def test_reading_the_status_touches_no_network(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The property that makes the outbound call acceptable at all. The dashboard polls this
        endpoint every couple of seconds; if it fetched, the product would be phoning home."""

        def forbidden(*_: object, **__: object) -> None:
            raise AssertionError("the status endpoint reached the network")

        monkeypatch.setattr(urllib.request, "urlopen", forbidden)

        from junon.ide_bridge_status import read_status

        read_status()

    def test_importing_junon_touches_no_network(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import importlib

        def forbidden(*_: object, **__: object) -> None:
            raise AssertionError("importing the package reached the network")

        monkeypatch.setattr(urllib.request, "urlopen", forbidden)

        importlib.reload(importlib.import_module("junon.published"))


@pytest.fixture
def client() -> FlaskClient:
    api = JunonDashboardAPI(
        memory_log_handler=MagicMock(),
        tool_names=["ide_status"],
        agent=MagicMock(),
        tool_usage_stats=None,
    )
    return api._app.test_client()


class TestTheRoute:
    def test_a_check_without_the_token_is_refused(self, client: FlaskClient) -> None:
        assert client.post("/junon/ide-bridge/check-upstream").status_code == 403

    def test_a_refused_check_does_not_reach_the_network(
        self, client: FlaskClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise any page in the browser could make this process fetch, token or not."""

        def forbidden(*_: object, **__: object) -> None:
            raise AssertionError("a refused request still fetched")

        monkeypatch.setattr(urllib.request, "urlopen", forbidden)

        client.post("/junon/ide-bridge/check-upstream")

    def test_the_verdict_is_returned_to_a_request_that_carries_the_token(
        self, client: FlaskClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from junon import published

        monkeypatch.setattr(published, "latest_release", lambda *_, **__: Advertised("9.9.9"))

        response = client.post(
            "/junon/ide-bridge/check-upstream",
            headers={"X-JUNON-Token": _token()},
        )

        assert response.status_code == 200
        assert response.get_json()["latest"] == "9.9.9"


def _token() -> str:
    from junon.update_action import SESSION_TOKEN

    return SESSION_TOKEN
