"""That the dashboard serves a page, not merely that the class was swapped.

The existing composition tests assert `serena.agent.SerenaDashboardAPI is JunonDashboardAPI`. That
is true of a dashboard which then answers 404, and for a while it was: `JUNON_DASHBOARD_DIR` did not
exist, `serve_junon_index` had replaced the upstream view that used to serve the page, and
`GET /dashboard/` — the address the root redirect sends every visitor to — returned 404 while every
test passed.

So these ask for URLs. A rebind that cannot be observed through a request is not a feature.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from flask.testing import FlaskClient

from junon.dashboard import JUNON_DASHBOARD_DIR, JunonDashboardAPI


@pytest.fixture
def client() -> FlaskClient:
    api = JunonDashboardAPI(
        memory_log_handler=MagicMock(),
        tool_names=["ide_status"],
        agent=MagicMock(),
        tool_usage_stats=None,
    )
    return api._app.test_client()


class TestTheFrontDoor:
    def test_the_dashboard_index_is_served(self, client: FlaskClient) -> None:
        """The address `/` redirects to. A 404 here is the whole dashboard, gone."""
        assert client.get("/dashboard/").status_code == 200

    def test_the_root_redirect_lands_somewhere_that_answers(self, client: FlaskClient) -> None:
        response = client.get("/", follow_redirects=True)

        assert response.status_code == 200

    def test_the_page_served_is_ours(self, client: FlaskClient) -> None:
        body = client.get("/dashboard/").get_data(as_text=True)

        assert "JUNON" in body

    def test_serenas_own_dashboard_is_still_reachable(self, client: FlaskClient) -> None:
        """Replacing the front end must not remove the one it replaced — a user who needs the
        upstream page during a JUNON problem should not have to uninstall anything to reach it."""
        assert client.get("/serena-dashboard/").status_code == 200


class TestTheBuiltAssets:
    def test_the_dashboard_directory_exists(self) -> None:
        assert Path(JUNON_DASHBOARD_DIR).is_dir(), (
            f"{JUNON_DASHBOARD_DIR} is missing; the index view falls back to Serena's page, which "
            "is a working dashboard but not this one"
        )

    def test_the_brand_assets_the_page_references_are_present(self) -> None:
        """The page names these in `src` attributes; a missing one is a broken image on the only
        screen a user ever looks at."""
        for asset in ("index.html", "favicon.svg", "junon-emblem.svg"):
            assert (Path(JUNON_DASHBOARD_DIR) / asset).is_file(), f"{asset} is missing"

    def test_the_page_only_calls_endpoints_that_exist(self) -> None:
        """Every path the front end fetches must be a route this server registers.

        A dashboard calling an endpoint that was renamed upstream shows empty panels and no error,
        which is indistinguishable from a project that genuinely has nothing to show.
        """
        api = JunonDashboardAPI(
            memory_log_handler=MagicMock(),
            tool_names=[],
            agent=MagicMock(),
            tool_usage_stats=None,
        )
        registered = {str(rule) for rule in api._app.url_map.iter_rules()}
        page = (Path(JUNON_DASHBOARD_DIR) / "index.html").read_text(encoding="utf-8")

        called = {
            line.split('getJson("')[1].split('"')[0]
            for line in page.splitlines()
            if 'getJson("' in line
        }

        assert called, "no endpoint calls were found in the page; this guard is not guarding"
        assert called <= registered, f"the page calls routes this server does not serve: {called - registered}"
