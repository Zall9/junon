"""What the IDE Bridge panel says, and the contradiction it is no longer allowed to utter.

On 2026-09-15 the panel showed this, all at once, with GoLand open on the project:

    Daemon running, no IDE attached
    Endpoint  ws://127.0.0.1:56178/rpc
    The daemon is running but did not answer: Could not reach the IDE Bridge daemon
    at ws://127.0.0.1:56178/rpc: [Errno 61] Connection refused

Two claims that cannot both be true. The daemon had died three weeks earlier when the disk filled,
and `read_status` treated *the existence of the discovery file* as proof that a daemon was running —
while `doctor`, asking the same question in TypeScript, had said `daemon-process: pid-not-running`
correctly the whole time. Nothing here tested `read_status` at all, so a stale file had never been
put in front of it.

So this file exists at two levels. Each state gets a test, and above them sits an **invariant over
every state**: no answer may claim a daemon is running and report that it could not be reached. The
per-state tests pin today's wording; the invariant would have caught this defect without anyone
having thought of a stale discovery file.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from junon import ide_bridge_status
from junon.client import IdeBridgeError
from junon.ide_bridge_status import STATUS_MEANINGS, daemon_process_is_gone, read_status

DASHBOARD_HTML = Path(ide_bridge_status.__file__).parent / "resources" / "dashboard" / "index.html"


def _started(pid: int) -> float:
    """When that pid started, the way a daemon would record it. `time.time()` for a pid that is gone."""
    import psutil

    try:
        return psutil.Process(pid).create_time() + 0.16
    except psutil.NoSuchProcess:
        return time.time()


@pytest.fixture
def discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Writes a discovery file the way the daemon does, for whichever process the test names."""

    def write(pid: int, started_at: float | None = None, **overrides: Any) -> Path:
        # Defaults to the moment that pid actually started, plus the skew a real daemon shows
        # (measured: +0.16 s between the kernel's start time and the `startedAt` it writes).
        # Writing `time.time()` instead made these tests pass alone and fail in the suite — by then
        # the pytest process was half a minute old, and a file claiming it had just started was
        # correctly judged to describe somebody else.
        moment = started_at if started_at is not None else _started(pid)
        payload: dict[str, Any] = {
            "protocolVersion": "0.1.0",
            "endpoint": "ws://127.0.0.1:56178/rpc",
            "token": "t" * 32,
            "pid": pid,
            "startedAt": datetime.datetime.fromtimestamp(moment, datetime.UTC)
            .isoformat()
            .replace("+00:00", "Z"),
        }
        payload.update(overrides)
        path = tmp_path / "discovery.json"
        path.write_text(json.dumps(payload))
        path.chmod(0o600)
        monkeypatch.setenv(ide_bridge_status.DISCOVERY_ENV_VAR, str(path))
        return path

    return write


def _pid_of_a_process_that_has_exited() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _answering(workspaces: list[dict[str, Any]], adapters: list[dict[str, Any]] | None = None):
    """A client that answers, so the states past the port test can be reached."""

    class FakeClient:
        def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
            return {
                "workspace/list": {"workspaces": workspaces},
                "bridge/listAdapters": {"adapters": adapters or []},
                "bridge/getStatus": {"daemonVersion": "0.3.0"},
            }[method]

    return FakeClient()


def _refusing():
    class FakeClient:
        def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
            raise IdeBridgeError(
                "Could not reach the IDE Bridge daemon at ws://127.0.0.1:56178/rpc: [Errno 61] Connection refused"
            )

    return FakeClient()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    def use(fake) -> None:  # noqa: ANN001
        monkeypatch.setattr("junon.client.IdeBridgeClient", lambda *a, **k: fake)

    return use


# --- the defect itself ---------------------------------------------------------------------------


class TestAStaleDiscoveryFile:
    def test_a_file_whose_process_is_gone_is_not_a_running_daemon(self, discovery, client) -> None:
        """The exact situation of 2026-09-15: the file outlived the daemon by three weeks."""
        discovery(pid=_pid_of_a_process_that_has_exited())
        client(_refusing())

        answer = read_status()

        assert answer["status"] == "no-daemon"
        assert "no daemon is running" in answer["reason"].lower()

    def test_it_says_which_pid_it_was_and_what_to_do(self, discovery, client) -> None:
        """A reader who sees this has to get from here to a working bridge without guessing."""
        dead = _pid_of_a_process_that_has_exited()
        discovery(pid=dead)
        client(_refusing())

        reason = read_status()["reason"]

        assert str(dead) in reason
        assert "bin.js daemon" in reason
        assert "tool window" in reason

    def test_a_recycled_pid_is_not_the_daemon_that_wrote_the_file(self, discovery, client) -> None:
        """ADR-0040, on this file too: a pid that came round again wears a start time of its own."""
        discovery(pid=os.getpid(), started_at=time.time() - 3600)
        client(_refusing())

        assert read_status()["status"] == "no-daemon"

    def test_a_live_daemon_within_the_tolerance_is_not_called_gone(self, discovery) -> None:
        """The control. Measured on this machine: the daemon records `startedAt` 0.16 s after the
        kernel's start time for its pid, so a rule tighter than that would call every daemon dead."""
        import psutil

        me = psutil.Process()
        recorded = datetime.datetime.fromtimestamp(me.create_time() + 0.16, datetime.UTC)
        payload = {"pid": me.pid, "startedAt": recorded.isoformat().replace("+00:00", "Z")}

        assert daemon_process_is_gone(payload) is False

    @pytest.mark.parametrize(
        "payload",
        [
            {},  # a file from before `pid` was written
            {"pid": "not-a-number"},
            {"pid": os.getpid()},  # no startedAt to compare
            {"pid": os.getpid(), "startedAt": "not a date"},
        ],
    )
    def test_what_cannot_be_told_is_not_reported_as_gone(self, payload: dict[str, Any]) -> None:
        """Unknowable is not the same as gone. Answering "gone" here would hide a working daemon."""
        assert daemon_process_is_gone(payload) is False


# --- every other state ---------------------------------------------------------------------------


class TestTheOtherStates:
    def test_no_file_at_all(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(ide_bridge_status.DISCOVERY_ENV_VAR, str(tmp_path / "absent.json"))

        assert read_status()["status"] == "no-daemon"

    def test_a_live_process_whose_endpoint_refuses_is_its_own_state(self, discovery, client) -> None:
        """Alive and silent: starting, wedged, or listening elsewhere. Not "no IDE attached"."""
        discovery(pid=os.getpid())
        client(_refusing())

        answer = read_status()

        assert answer["status"] == "daemon-unreachable"
        assert "did not answer" in answer["reason"]

    def test_a_daemon_that_answers_with_no_workspace(self, discovery, client) -> None:
        discovery(pid=os.getpid())
        client(_answering(workspaces=[]))

        answer = read_status()

        assert answer["status"] == "no-adapter"
        assert "no IDE has a workspace open" in answer["reason"]

    def test_a_daemon_with_an_ide_attached(self, discovery, client) -> None:
        discovery(pid=os.getpid())
        client(
            _answering(
                workspaces=[{"workspaceId": "ws_1", "name": "moneta", "adapterId": "adapter_1", "roots": []}],
                adapters=[{"adapterId": "adapter_1", "ideKind": "goland", "version": "0.3.0", "capabilities": {}}],
            )
        )

        answer = read_status()

        assert answer["status"] == "connected"
        assert answer["reason"] is None
        assert answer["adapter"]["ideKind"] == "goland"

    def test_the_token_never_leaves_this_process(self, discovery, client) -> None:
        """Whatever the state. The discovery file carries it and a dashboard response is the last
        place it should appear."""
        discovery(pid=_pid_of_a_process_that_has_exited())
        client(_refusing())

        assert "t" * 32 not in json.dumps(read_status())


# --- the invariant, which is what would have caught it -------------------------------------------


ALL_STATES = [
    ("no file", "absent", None),
    ("stale file", "dead", _refusing),
    ("alive, silent", "alive", _refusing),
    ("alive, no workspace", "alive", lambda: _answering([])),
    (
        "alive, connected",
        "alive",
        lambda: _answering(
            [{"workspaceId": "ws_1", "name": "moneta", "adapterId": "a", "roots": []}],
            [{"adapterId": "a", "ideKind": "goland", "version": "0.3.0", "capabilities": {}}],
        ),
    ),
]


@pytest.mark.parametrize("label,process,make_client", ALL_STATES, ids=[s[0] for s in ALL_STATES])
class TestTheAnswerNeverContradictsItself:
    """Over every state this module can report — not over the ones somebody remembered to imagine.

    The defect that prompted these tests was not a wrong branch; it was two branches disagreeing.
    A per-state assertion would have been written for the states its author had in mind, and a
    stale discovery file was not one of them. These hold whatever the state.
    """

    def _answer(self, label, process, make_client, tmp_path, monkeypatch, discovery, client):  # noqa: ANN001, ANN202
        if process == "absent":
            monkeypatch.setenv(ide_bridge_status.DISCOVERY_ENV_VAR, str(tmp_path / "absent.json"))
        else:
            discovery(pid=os.getpid() if process == "alive" else _pid_of_a_process_that_has_exited())
        if make_client is not None:
            client(make_client())
        return read_status()

    def test_it_never_claims_a_daemon_is_running_and_unreachable_at_once(
        self, label, process, make_client, tmp_path, monkeypatch, discovery, client
    ) -> None:
        answer = self._answer(label, process, make_client, tmp_path, monkeypatch, discovery, client)
        reason = (answer.get("reason") or "").lower()

        claims_running = "daemon is running" in reason
        claims_unreachable = "could not reach" in reason or "refused" in reason
        assert not (claims_running and claims_unreachable), f"{label}: {answer['reason']}"

    def test_only_connected_reports_an_adapter(
        self, label, process, make_client, tmp_path, monkeypatch, discovery, client
    ) -> None:
        answer = self._answer(label, process, make_client, tmp_path, monkeypatch, discovery, client)

        if answer["status"] != "connected":
            assert not answer.get("adapter"), f"{label} reported an adapter while not connected"

    def test_every_state_is_one_the_panel_knows(
        self, label, process, make_client, tmp_path, monkeypatch, discovery, client
    ) -> None:
        answer = self._answer(label, process, make_client, tmp_path, monkeypatch, discovery, client)

        assert answer["status"] in STATUS_MEANINGS

    def test_a_reason_is_given_whenever_something_is_not_connected(
        self, label, process, make_client, tmp_path, monkeypatch, discovery, client
    ) -> None:
        """A panel that shows a warning tone with no sentence leaves a reader to guess."""
        answer = self._answer(label, process, make_client, tmp_path, monkeypatch, discovery, client)

        if answer["status"] != "connected":
            assert (answer.get("reason") or "").strip(), f"{label} gave no reason"


class TestEveryStateIsCovered:
    def test_the_invariants_run_over_every_status_this_module_can_report(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, discovery, client
    ) -> None:
        """The loop-closer, and it runs the states rather than reasoning about them.

        A status added to `STATUS_MEANINGS` without a row in `ALL_STATES` would be a state no
        invariant above ever sees — which is how the last one shipped: not by a wrong branch, but
        by a branch nobody looked at. `unreadable` is excluded and has its own tests.
        """
        produced = set()
        for _label, process, make_client in ALL_STATES:
            if process == "absent":
                monkeypatch.setenv(ide_bridge_status.DISCOVERY_ENV_VAR, str(tmp_path / "absent.json"))
            else:
                discovery(pid=os.getpid() if process == "alive" else _pid_of_a_process_that_has_exited())
            if make_client is not None:
                client(make_client())
            produced.add(read_status()["status"])

        assert produced == set(STATUS_MEANINGS) - {"unreadable"}, (
            "a status is declared but no row in ALL_STATES produces it: give it one, "
            f"missing = {set(STATUS_MEANINGS) - {'unreadable'} - produced}"
        )


class TestThePanelCanRenderThem:
    def test_the_dashboard_has_a_label_for_every_status(self) -> None:
        """An unmapped status falls through to "Unreadable" — a sentence about the file, not the
        daemon. That is how a new state ships looking like a broken dashboard."""
        html = DASHBOARD_HTML.read_text(encoding="utf-8")
        rendered = set(re.findall(r'state === "([a-z-]+)"', html))

        missing = [s for s in STATUS_MEANINGS if s != "unreadable" and s not in rendered]
        assert missing == [], f"the panel has no label for: {missing}"
