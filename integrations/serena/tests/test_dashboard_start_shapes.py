"""Starting the dashboard on whichever Serena someone already had.

`compose()` reports what it rebound, and rebinding is not the same as working. It reported complete
against Serena 1.5.3 while the server it composed onto died in its own constructor:
`run_in_thread(self, host)` there, `run_in_thread(self)` in 1.7, and an override fixed to the second
raises `TypeError` on the first. Nothing caught it, because every test ran against the one version
this repository pins.

So these call the override the way each Serena calls it, with upstream's own method faked out — the
point is the argument shapes, not Flask.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from serena.dashboard import SerenaDashboardAPI

from junon import dashboard_registry
from junon.dashboard import JunonDashboardAPI

PORT = 24291


@pytest.fixture
def api() -> JunonDashboardAPI:
    dashboard = JunonDashboardAPI(
        memory_log_handler=MagicMock(),
        tool_names=["ide_status"],
        agent=MagicMock(),
        tool_usage_stats=None,
    )
    # A real project name, not the mock's. `publish` serialises it, and a MagicMock raises there —
    # swallowed by the catch below, which would leave these tests asserting only that this file
    # appended to its own list. Found by mutation: narrowing the catch failed tests that had
    # nothing to do with it.
    dashboard._agent = SimpleNamespace(_active_project=SimpleNamespace(project_name="moneta"))
    return dashboard


@pytest.fixture
def published(tmp_path, monkeypatch) -> list[str]:
    """Every URL published, without touching the real registry directory."""
    monkeypatch.setenv(dashboard_registry.REGISTRY_ENV_VAR, str(tmp_path / "dashboards"))
    urls: list[str] = []
    original = dashboard_registry.publish

    def record(url: str, *args: Any, **kwargs: Any):
        urls.append(url)
        return original(url, *args, **kwargs)

    monkeypatch.setattr(dashboard_registry, "publish", record)
    return urls


def _fake_upstream(*args: Any, **kwargs: Any) -> tuple[str, int]:
    """Upstream's method, accepting either shape so the test is about ours."""
    return ("thread", PORT)


def test_serena_1_5_3_passes_the_host_as_an_argument(api: JunonDashboardAPI, published: list[str]) -> None:
    """`run_in_thread(host=...)`. This raised TypeError inside the agent's constructor, which is
    fatal: composing onto an older Serena stopped it from starting at all."""
    with patch.object(SerenaDashboardAPI, "run_in_thread", _fake_upstream):
        thread, port = api.run_in_thread(host="10.0.0.7")

    assert (thread, port) == ("thread", PORT)
    assert published == [f"http://10.0.0.7:{PORT}/dashboard/"]
    # Read back through the registry rather than trusting the call: this is what the IDE reads.
    recorded = dashboard_registry.read_all()
    assert [(entry.url, entry.project) for entry in recorded] == [
        (f"http://10.0.0.7:{PORT}/dashboard/", "moneta")
    ]


def test_serena_1_7_keeps_the_host_on_the_instance(api: JunonDashboardAPI, published: list[str]) -> None:
    """`run_in_thread()`, address read from `self._host`."""
    api._host = "127.0.0.2"

    with patch.object(SerenaDashboardAPI, "run_in_thread", _fake_upstream):
        api.run_in_thread()

    assert published == [f"http://127.0.0.2:{PORT}/dashboard/"]


def test_a_positional_host_is_understood_too(api: JunonDashboardAPI, published: list[str]) -> None:
    """The same call as 1.5.3's, written positionally. A caller's choice of syntax is not a
    different situation, and treating it as one would publish an address nobody is listening on."""
    with patch.object(SerenaDashboardAPI, "run_in_thread", _fake_upstream):
        api.run_in_thread("10.0.0.8")

    assert published == [f"http://10.0.0.8:{PORT}/dashboard/"]


def test_a_registry_that_cannot_be_written_does_not_stop_the_server(api: JunonDashboardAPI) -> None:
    """This runs inside the agent's constructor. A bookkeeping file is not worth a server."""
    with (
        patch.object(SerenaDashboardAPI, "run_in_thread", _fake_upstream),
        patch.object(dashboard_registry, "publish", side_effect=RuntimeError("disk is gone")),
    ):
        assert api.run_in_thread() == ("thread", PORT)
