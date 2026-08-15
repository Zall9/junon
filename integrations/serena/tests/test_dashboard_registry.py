"""How the IDE finds a running JUNON dashboard.

The plugin knows the daemon and nothing else. Serena's dashboard picks its port at start-up from
whatever is free — four were observed on one machine in one evening, on 24282, 24283, 24284 and
24286 — so a single well-known file would describe whichever instance wrote last, and a guessed port
would be wrong most of the time.

Liveness is the part worth testing: a link to a dashboard that has stopped is worse than no link.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from junon import dashboard_registry


@pytest.fixture(autouse=True)
def registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(dashboard_registry.REGISTRY_ENV_VAR, str(tmp_path / "dashboards"))
    return tmp_path / "dashboards"


def test_a_published_dashboard_is_found() -> None:
    dashboard_registry.publish("http://127.0.0.1:24284/dashboard/", project="serena")

    found = dashboard_registry.read_all()

    assert [d.url for d in found] == ["http://127.0.0.1:24284/dashboard/"]
    assert found[0].project == "serena"
    assert found[0].pid == os.getpid()


def test_several_instances_are_all_reported() -> None:
    """Two Serena processes are an ordinary state, not an error to resolve by picking one."""
    dashboard_registry.publish("http://127.0.0.1:24282/dashboard/", pid=os.getpid())
    dashboard_registry.publish("http://127.0.0.1:24283/dashboard/", pid=os.getppid())

    assert len(dashboard_registry.read_all()) == 2


def test_an_entry_whose_process_is_gone_is_dropped(registry: Path) -> None:
    """A crashed dashboard leaves its file behind. Offering that link sends a user to a dead port."""
    # A pid that cannot be running: the kernel never assigns it.
    registry.mkdir(parents=True, exist_ok=True)
    (registry / "999999.json").write_text(
        json.dumps({"url": "http://127.0.0.1:24999/dashboard/", "pid": 999999})
    )

    assert dashboard_registry.read_all() == []


def test_a_stale_entry_is_removed_as_it_is_found(registry: Path) -> None:
    """Otherwise the directory grows one file per crash, for ever."""
    registry.mkdir(parents=True, exist_ok=True)
    stale = registry / "999998.json"
    stale.write_text(json.dumps({"url": "http://127.0.0.1:24998/dashboard/", "pid": 999998}))

    dashboard_registry.read_all()

    assert not stale.exists()


def test_a_damaged_entry_does_not_hide_a_good_one(registry: Path) -> None:
    """One unreadable file must not cost the reader every other dashboard."""
    registry.mkdir(parents=True, exist_ok=True)
    (registry / "broken.json").write_text("{not json")
    dashboard_registry.publish("http://127.0.0.1:24284/dashboard/")

    assert [d.url for d in dashboard_registry.read_all()] == [
        "http://127.0.0.1:24284/dashboard/"
    ]


def test_unpublishing_removes_only_this_process(registry: Path) -> None:
    dashboard_registry.publish("http://127.0.0.1:24282/dashboard/", pid=os.getpid())
    dashboard_registry.publish("http://127.0.0.1:24283/dashboard/", pid=os.getppid())

    dashboard_registry.unpublish()

    assert [d.pid for d in dashboard_registry.read_all()] == [os.getppid()]


def test_reading_an_absent_directory_is_not_an_error() -> None:
    """No dashboard running is the ordinary state before anything starts."""
    assert dashboard_registry.read_all() == []
