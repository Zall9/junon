"""`junon instances --stop`: ending the shared instances on demand, and refusing to end the busy ones.

Asked directly, on 2026-09-15: *what is the solution to restart every JUNON fresh — is quitting
opencode enough?* It is not, and the reason is a design decision: a host's stdio children die with
it (measured: one second after the pipe closes), while a shared instance is deliberately re-parented
to launchd so that it outlives the session that started it. Until this command, nothing could end
one on demand — the only routes were waiting out the idle period or `pkill`, which is not an answer
a product gives.

The rule it must not break is the one every other part of this file already keeps: an instance with
a session attached is doing someone's work, and a version number is not a reason to take it away.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from junon import instances

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


class Killer:
    """Records the signals that would have been sent, so the decision is testable without deaths."""

    def __init__(self, vanished: set[int] | None = None) -> None:
        self.sent: list[tuple[int, int]] = []
        self.vanished = vanished or set()

    def __call__(self, pid: int, signal_number: int) -> None:
        if pid in self.vanished:
            raise ProcessLookupError(pid)
        self.sent.append((pid, signal_number))


class TestWhatItStops:
    def test_an_instance_with_no_session_is_stopped(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)
        killer = Killer()

        stopped, kept = instances.stop_free(kill=killer)

        assert [i.port for i in stopped] == [4242]
        assert kept == []
        assert killer.sent == [(os.getpid(), 15)], "SIGTERM, the same exit the idle watchdog uses"

    def test_an_instance_with_a_session_is_left_alone(self, tmp_path: Path) -> None:
        """The rule this command must not break to be convenient."""
        instances.publish_instance(tmp_path, 4242)
        instances.publish_client(tmp_path, instance_pid=os.getpid())
        killer = Killer()

        stopped, kept = instances.stop_free(kill=killer)

        assert stopped == []
        assert [i.port for i in kept] == [4242]
        assert killer.sent == [], "nothing may be signalled while a session is on it"

    def test_one_that_left_on_its_own_first_is_not_claimed(self, tmp_path: Path) -> None:
        """An idle exit that beat us to it is the outcome this was asking for — but it was not this
        command that did it, and saying otherwise would be a small lie in a report people trust."""
        instances.publish_instance(tmp_path, 4242)
        killer = Killer(vanished={os.getpid()})

        stopped, kept = instances.stop_free(kill=killer)

        assert stopped == [] and kept == []

    def test_nothing_running_says_so(self) -> None:
        stopped, kept = instances.stop_free(kill=Killer())

        assert instances.stop_report(stopped, kept).startswith("No shared JUNON instance is running")


class TestWhatItSays:
    def test_it_names_what_it_stopped_and_what_comes_next(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)

        report = instances.stop_report(*instances.stop_free(kill=Killer()))

        assert "Stopped 1 instance(s)" in report
        assert str(tmp_path.resolve()) in report
        assert "starts a fresh one on the installed JUNON" in report

    def test_it_names_what_it_refused_to_stop_and_offers_the_way_through(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)
        instances.publish_client(tmp_path, instance_pid=os.getpid())

        report = instances.stop_report(*instances.stop_free(kill=Killer()))

        assert "a session is attached" in report
        assert "1 session(s)" in report
        # Since 0.3.7 those sessions survive it, so the report says so rather than only refusing.
        assert "--all" in report
        assert "reattach to a fresh instance" in report


class TestStoppingEverything:
    def test_all_stops_the_busy_ones_too(self, tmp_path: Path) -> None:
        """Only reasonable because a relay follows its instance now: the sessions on it reconnect
        on their next call instead of being finished."""
        instances.publish_instance(tmp_path, 4242)
        instances.publish_client(tmp_path, instance_pid=os.getpid())
        killer = Killer()

        stopped, kept = instances.stop_free(kill=killer, including_busy=True)

        assert [i.port for i in stopped] == [4242]
        assert kept == []
        assert killer.sent == [(os.getpid(), 15)]

    def test_it_is_not_the_default(self, tmp_path: Path) -> None:
        """The cost is a call in flight reported as unknown; whether to pay it is the caller's."""
        instances.publish_instance(tmp_path, 4242)
        instances.publish_client(tmp_path, instance_pid=os.getpid())

        stopped, kept = instances.stop_free(kill=Killer())

        assert stopped == [] and [i.port for i in kept] == [4242]


class TestTheRealThing:
    """~20 s: a real instance, stopped by the real command, watched leaving."""

    def test_the_subcommand_ends_a_live_instance(self, tmp_path: Path) -> None:
        from junon.attach import spawn_serve

        pid = spawn_serve(str(REPO_ROOT), 30.0, ["--log-level", "ERROR"])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            found = instances.instance_for(REPO_ROOT)
            if found and found.pid == pid:
                break
            time.sleep(0.5)
        else:
            pytest.fail("the instance never registered")

        launch = (
            "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); "
            "runpy.run_module('junon', run_name='__main__', alter_sys=True)"
        )
        result = subprocess.run(
            [sys.executable, "-c", launch, str(PACKAGE_ROOT), "instances", "--stop"],
            capture_output=True,
            text=True,
            env={**os.environ, instances.REGISTRY_ENV_VAR: str(tmp_path)},
        )

        assert "Stopped 1 instance(s)" in result.stdout, result.stdout
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if not psutil.pid_exists(pid):
                break
            time.sleep(0.5)
        else:
            psutil.Process(pid).kill()
            pytest.fail("the instance was reported stopped and is still running")
        assert instances.instance_for(REPO_ROOT) is None
