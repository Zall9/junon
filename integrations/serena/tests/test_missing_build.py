"""What the dashboard does when its own files are not there.

This is the state that produced a support report: JUNON running, composed, tools registered — and
Serena's dashboard on the screen, because the index view falls back when its assets are missing. The
fallback is right (a page that is not ours beats a 404 on the front door), and it was silent: the
warning goes to a log that an agent host swallows, so the only thing a person sees is the wrong page.

Two rules, then. The fallback still happens, and it says why.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask.testing import FlaskClient

from junon import dashboard as dashboard_module
from junon.dashboard import JunonDashboardAPI


@pytest.fixture
def client_without_a_build(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FlaskClient:
    """A JUNON whose dashboard directory is empty — an install that did not carry its resources."""
    monkeypatch.setattr(dashboard_module, "JUNON_DASHBOARD_DIR", str(tmp_path))
    api = JunonDashboardAPI(
        memory_log_handler=MagicMock(),
        tool_names=["ide_status"],
        agent=MagicMock(),
        tool_usage_stats=None,
    )
    return api._app.test_client()


class TestTheFrontDoorStillAnswers:
    def test_a_page_is_served(self, client_without_a_build: FlaskClient) -> None:
        """The reason the fallback exists: without it the dashboard's front door is a 404."""
        assert client_without_a_build.get("/dashboard/").status_code == 200


class TestItSaysWhichPageThisIs:
    def test_the_page_names_the_situation(self, client_without_a_build: FlaskClient) -> None:
        body = client_without_a_build.get("/dashboard/").get_data(as_text=True)

        assert "This is Serena's dashboard, not JUNON's" in body

    def test_it_names_the_directory_that_is_empty(
        self, client_without_a_build: FlaskClient, tmp_path: Path
    ) -> None:
        """"Files are missing" without a path sends someone hunting. The place is the whole answer."""
        body = client_without_a_build.get("/dashboard/").get_data(as_text=True)

        assert str(tmp_path) in body

    def test_it_points_at_the_diagnostic(self, client_without_a_build: FlaskClient) -> None:
        body = client_without_a_build.get("/dashboard/").get_data(as_text=True)

        assert "diagnose-dashboard.sh" in body

    def test_it_does_not_claim_the_tools_are_broken(
        self, client_without_a_build: FlaskClient
    ) -> None:
        """They are not: the composition applied, and only the front end is absent. A banner that
        overstated the failure would send someone to reinstall a working installation."""
        body = client_without_a_build.get("/dashboard/").get_data(as_text=True)

        assert "unaffected" in body


class TestTheRealBuildIsUntouched:
    def test_the_shipped_dashboard_is_served_without_a_banner(self) -> None:
        api = JunonDashboardAPI(
            memory_log_handler=MagicMock(),
            tool_names=["ide_status"],
            agent=MagicMock(),
            tool_usage_stats=None,
        )
        body = api._app.test_client().get("/dashboard/").get_data(as_text=True)

        assert "JUNON" in body
        assert "This is Serena's dashboard" not in body
