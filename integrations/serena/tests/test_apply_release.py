"""What one click does, now that it is one sequence instead of two routes each assembling an answer.

The goal it serves, in the words it was asked for: *click install → quit the IDEs → everything works,
with no other interaction*. Measured on 2026-09-16, a click reached exactly one half of the product —
the plugin. The shared JUNON instances kept the code they had imported, which is the whole of "why
did the update not take", asked three times in one day.

Stopping a busy instance only became reasonable in 0.3.7, when the relay learned to follow its
instance: before that it would have ended those sessions, so the button was right not to.
"""

from __future__ import annotations

from typing import Any

import pytest

from junon import instances, update_action
from junon.update_action import InstallOutcome, apply_release, refresh_instances


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path / "registry"))
    return tmp_path


@pytest.fixture
def installed(monkeypatch: pytest.MonkeyPatch):
    """The plugin half, faked, so these tests are about the sequence and not about zip files."""

    def use(outcome: InstallOutcome) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []

        def fake_install(timeout: float = 300.0, quit_running: bool = False) -> InstallOutcome:
            calls.append({"quit_running": quit_running})
            return outcome

        monkeypatch.setattr(update_action, "install", fake_install)
        return calls

    return use



@pytest.fixture
def steps():
    """The two steps that touch the machine, replaced by recorders.

    Not optional politeness: the first version of these tests let `apply_release` run the real ones,
    and every run stopped and restarted the developer's own daemon — 0.4 s of tests became 33 s, and
    on a working machine it would have dropped a live IDE's connection mid-edit.
    """
    from junon import daemon_control

    calls: dict[str, int] = {"restart": 0, "verify": 0}

    def restart():
        calls["restart"] += 1
        return daemon_control.Restart("restarted", "The daemon was replaced: pid 1 stopped, pid 2 now answering.", 1, 2)

    def check():
        calls["verify"] += 1
        return {"agrees": True, "sentence": "Verified: everything at 9.9.9.", "wanted": "9.9.9"}

    return calls, restart, check

class Killer:
    """Stands in for `os.kill`, which is two different questions here.

    Liveness is asked with signal 0 — `instances._alive` — and stopping with SIGTERM. A recorder
    that kept only pids reported three calls where one mattered, and the test read as though
    `refresh_instances` had killed the same process three times.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[int, int]] = []

    def __call__(self, pid: int, signal_number: int) -> None:
        self.calls.append((pid, signal_number))

    @property
    def terminated(self) -> list[int]:
        import signal as signals

        return [pid for pid, number in self.calls if number == signals.SIGTERM]


class TestRefreshInstances:
    def test_it_stops_every_instance_including_the_busy_ones(self, tmp_path, monkeypatch) -> None:
        import os

        # Somebody else's instance: the sequence spares only the process running it, and this test
        # process is that one. Published under the parent's pid, which is alive and is not us.
        other = os.getppid()
        instances.publish_instance(tmp_path, 4242, pid=other)
        instances.publish_client(tmp_path, instance_pid=other)
        killer = Killer()
        monkeypatch.setattr(os, "kill", killer)

        stopped = refresh_instances()

        assert stopped == (str(tmp_path.resolve()),)
        assert killer.terminated == [other]

    def test_nothing_running_is_nothing_stopped(self) -> None:
        assert refresh_instances() == ()


class TestItKeepsTheGroundItStandsOn:
    """Pressed for real on 2026-09-16, and the page went dead: *ERR_CONNECTION_REFUSED*.

    The dashboard is served *by* a shared instance, and the sequence stopped every shared instance.
    So the process answering the request stopped itself mid-answer — the browser got nothing, and
    the steps after that ran inside a process that was shutting down, which left the machine with no
    daemon at all. Every part of that is pinned below.
    """

    def test_the_instance_running_the_sequence_is_not_stopped(self, tmp_path, monkeypatch) -> None:
        import os

        instances.publish_instance(tmp_path / "mine", 4242, pid=os.getpid())
        # A second instance, belonging to somebody else, which must still be stopped.
        directory = tmp_path.parent / "other"
        directory.mkdir(exist_ok=True)
        instances.publish_instance(directory, 5555, pid=os.getppid())
        killer = Killer()
        monkeypatch.setattr(os, "kill", killer)

        stopped = refresh_instances()

        assert stopped == (str(directory.resolve()),), "only the other one may be stopped"
        assert killer.terminated == [os.getppid()]
        assert os.getpid() not in killer.terminated, "it must not stop the process that is answering"

    def test_the_daemon_is_restarted_before_anything_is_stopped(self, installed, steps, monkeypatch) -> None:
        """Order matters because stopping is the step that can go wrong. The first ordering stopped
        the instances first, died halfway, and never reached the daemon — leaving none."""
        import os

        order: list[str] = []
        installed(InstallOutcome((), ("GoLand",), (), ()))

        def restart():
            order.append("daemon")
            from junon import daemon_control

            return daemon_control.Restart("restarted", "daemon replaced", 1, 2)

        def stopping(*args: Any, **kwargs: Any):
            order.append("instances")
            return ((), ())

        monkeypatch.setattr(instances, "stop_free", stopping)
        _, _, check = steps
        apply_release(restart_daemon=restart, check=check)

        assert order == ["daemon", "instances"]


class TestApplyRelease:
    def test_it_installs_then_refreshes(self, tmp_path, installed, monkeypatch, steps) -> None:
        import os

        installs = installed(InstallOutcome(("GoLand",), (), (), ()))
        instances.publish_instance(tmp_path, 4242, pid=os.getppid())
        monkeypatch.setattr(os, "kill", Killer())

        _, restart, check = steps
        answer = apply_release(quit_running=True, restart_daemon=restart, check=check)

        assert installs == [{"quit_running": True}], "the quit flag must reach the installer"
        assert answer["installed"] == ["GoLand"]
        assert answer["instancesStopped"] == [str(tmp_path.resolve())]

    def test_the_answer_says_what_the_instances_mean_for_open_sessions(self, tmp_path, installed, monkeypatch, steps) -> None:
        """A list of paths tells a reader nothing; what they need to know is that they have nothing
        left to do about them."""
        import os

        installed(InstallOutcome((), ("GoLand",), (), ()))
        instances.publish_instance(tmp_path, 4242, pid=os.getppid())
        monkeypatch.setattr(os, "kill", Killer())

        calls, restart, check = steps
        told = apply_release(restart_daemon=restart, check=check)["next"]

        assert "Also stopped 1 shared JUNON instance(s)" in told
        assert "at its next call" in told
        assert "nothing to restart" in told

    def test_with_no_instances_the_answer_does_not_mention_them(self, installed, steps) -> None:
        installed(InstallOutcome((), ("GoLand", "PhpStorm"), (), ()))

        calls, restart, check = steps
        answer = apply_release(restart_daemon=restart, check=check)

        assert answer["instancesStopped"] == []
        assert "shared JUNON instance" not in answer["next"]
        assert answer["title"] == "Already current"

    def test_the_installer_s_own_verdict_is_carried_through(self, installed, steps) -> None:
        """The sequence adds to the answer; it does not overrule it."""
        installed(InstallOutcome((), (), ("PhpStorm",), ("PhpStorm",)))

        calls, restart, check = steps
        answer = apply_release(restart_daemon=restart, check=check)

        assert answer["ok"] is False
        assert answer["title"] == "Not installed"
        assert "quit it and press this again" in answer["next"]


class TestBothRoutesUseIt:
    @pytest.mark.parametrize("route", ["/junon/ide-bridge/install", "/junon/ide-bridge/quit-and-install"])
    def test_each_route_returns_the_whole_sequence(self, route: str, installed, monkeypatch, steps) -> None:
        """Two routes each assembling their own answer is how the plugin became the only half a
        click reached: adding a step meant remembering to add it twice."""
        from flask import Flask

        from junon.dashboard import JunonDashboardAPI
        from junon.update_action import SESSION_TOKEN

        installed(InstallOutcome(("GoLand",), (), (), ()))
        # The route calls `apply_release` with its own defaults, so the machine-touching steps are
        # replaced at the module level — otherwise pressing this button in a test really does stop
        # the developer's daemon.
        _, restart, check = steps
        monkeypatch.setattr(update_action, "verify", check)
        monkeypatch.setattr("junon.daemon_control.restart", restart)
        api = JunonDashboardAPI.__new__(JunonDashboardAPI)
        api._app = Flask("test")
        api._setup_junon_routes()

        with api._app.test_client() as web:
            body = web.post(route, headers={"X-JUNON-Token": SESSION_TOKEN}).get_json()

        assert body["installed"] == ["GoLand"]
        assert "instancesStopped" in body, f"{route} does not run the whole sequence"
        assert body["title"] == "Installed"
