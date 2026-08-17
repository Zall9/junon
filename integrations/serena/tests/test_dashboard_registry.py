"""How the IDE finds a running JUNON dashboard.

The plugin knows the daemon and nothing else. Serena's dashboard picks its port at start-up from
whatever is free — four were observed on one machine in one evening, on 24282, 24283, 24284 and
24286 — so a single well-known file would describe whichever instance wrote last, and a guessed port
would be wrong most of the time.

Liveness is the part worth testing: a link to a dashboard that has stopped is worse than no link.
And liveness is not "some process has this pid" — pids are reused, and these entries outlive their
processes by days, so the tests below hold the registry to the stronger claim it now makes: the
process answering to this pid is the one that wrote the entry.
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


def _own_start_time() -> float:
    """This process's start time, or a failure that says why the tests below cannot run.

    The recycled-pid guarantee rests on `psutil`, which is a declared dependency. Without it the
    registry falls back to identifying entries by pid alone, and every assertion about a recycled
    pid would pass by doing nothing at all. Failing here says that out loud instead.
    """
    started_at = dashboard_registry._start_time(os.getpid())
    assert started_at is not None, (
        "no start time for this process: psutil is missing, so the registry cannot tell a recycled "
        "pid from the process that published — install the declared dependencies"
    )
    return started_at


def _write(registry: Path, name: str, payload: dict[str, object]) -> Path:
    registry.mkdir(parents=True, exist_ok=True)
    path = registry / name
    path.write_text(json.dumps(payload))
    return path


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


def test_publishing_records_when_the_process_started(registry: Path) -> None:
    """The pid alone cannot say which process it means, so the entry carries the start time too."""
    path = dashboard_registry.publish("http://127.0.0.1:24282/dashboard/")

    written = json.loads(path.read_text())

    assert written["pid"] == os.getpid()
    assert written["started_at"] == pytest.approx(_own_start_time())


def test_a_live_pid_that_is_not_the_publisher_is_refused(registry: Path) -> None:
    """The whole point. This pid is running — it is this very test — but it is not the process that
    published, which is what a recycled pid looks like from here. Fourteen entries sat in the real
    directory for three days waiting for exactly this, and a pid-only check would offer every one of
    them the moment its number came round again."""
    _write(
        registry,
        f"{os.getpid()}.json",
        {
            "url": "http://127.0.0.1:24999/dashboard/",
            "pid": os.getpid(),
            "started_at": _own_start_time() - 3600,
        },
    )

    assert dashboard_registry.read_all() == []


def test_a_recycled_pid_entry_is_removed_as_it_is_found(registry: Path) -> None:
    """It is as stale as one whose process is gone, so it goes the same way."""
    stale = _write(
        registry,
        f"{os.getpid()}.json",
        {
            "url": "http://127.0.0.1:24999/dashboard/",
            "pid": os.getpid(),
            "started_at": _own_start_time() - 3600,
        },
    )

    dashboard_registry.read_all()

    assert not stale.exists()


def test_a_start_time_within_tolerance_is_the_same_process(registry: Path) -> None:
    """The JVM reads this field from its own plumbing, not from psutil, so equality has to be
    approximate — see the tolerance constant. Pinning it here stops it being tightened to an exact
    match, which would leave the IDE quietly showing no dashboards at all."""
    _write(
        registry,
        f"{os.getpid()}.json",
        {
            "url": "http://127.0.0.1:24282/dashboard/",
            "pid": os.getpid(),
            "started_at": _own_start_time() + 1.0,
        },
    )

    assert [d.url for d in dashboard_registry.read_all()] == ["http://127.0.0.1:24282/dashboard/"]


def test_an_entry_written_before_start_times_were_recorded_is_kept(registry: Path) -> None:
    """Upgrading must not blank the tool window for every JUNON that is already running."""
    _write(
        registry,
        f"{os.getpid()}.json",
        {"url": "http://127.0.0.1:24283/dashboard/", "pid": os.getpid()},
    )

    found = dashboard_registry.read_all()

    assert [d.url for d in found] == ["http://127.0.0.1:24283/dashboard/"]
    assert found[0].started_at is None


def test_an_unreadable_start_time_is_a_damaged_entry(registry: Path) -> None:
    """Present but not a number is corruption, not an entry from before the field existed, and the
    two must not be confused: one is unreadable and the other is merely old."""
    damaged = _write(
        registry,
        f"{os.getpid()}.json",
        {"url": "http://127.0.0.1:24284/dashboard/", "pid": os.getpid(), "started_at": "yesterday"},
    )

    assert dashboard_registry.read_all() == []
    assert not damaged.exists()


def test_a_start_time_that_cannot_be_read_falls_back_to_the_pid(
    registry: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without psutil the registry cannot answer the question. It then has to be no worse than it
    was before the field existed — an environment missing a dependency loses the check, not the
    dashboards."""
    _write(
        registry,
        f"{os.getpid()}.json",
        {
            "url": "http://127.0.0.1:24285/dashboard/",
            "pid": os.getpid(),
            "started_at": _own_start_time() - 3600,
        },
    )
    monkeypatch.setattr(dashboard_registry, "_start_time", lambda pid: None)

    assert [d.url for d in dashboard_registry.read_all()] == ["http://127.0.0.1:24285/dashboard/"]
