"""``junon attach``: the resolution, the find-or-start, and two real sessions sharing one instance.

The decisions are tested without processes — a launcher and a liveness check handed in — and then
the whole thing runs for real: two stdio sessions against this repository, one ``junon serve``
between them, counted rather than assumed, and the instance killed under a session to see what the
session says about it. That last part is the acceptance of ``docs/SHARED_JUNON_PLAN.md`` Phase 2.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
import pytest

from junon import instances
from junon.attach import StartFailed, find_or_start, resolve_root, serve_command

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
QUIET = ["--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"]


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


# --- resolving the project ---------------------------------------------------------------------


class TestResolveRoot:
    def test_an_explicit_project_wins_and_is_normalised(self, tmp_path: Path) -> None:
        assert resolve_root(str(tmp_path / "x" / "..")) == str(tmp_path.resolve())

    def test_without_one_the_nearest_git_root_above_cwd_is_the_project(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Serena's rule, reused rather than restated: the same answer `--project-from-cwd` gives."""
        (tmp_path / ".git").mkdir()
        inside = tmp_path / "src" / "deep"
        inside.mkdir(parents=True)
        monkeypatch.chdir(inside)

        assert resolve_root(None) == str(tmp_path.resolve())

    def test_nowhere_is_none_not_the_working_directory(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Attaching a shared instance to an arbitrary directory would index a home folder."""
        bare = tmp_path / "bare"
        bare.mkdir()
        monkeypatch.chdir(bare)

        assert resolve_root(None) is None


# --- find or start -----------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class TestFindOrStart:
    def test_a_live_answering_instance_is_reused_and_nothing_is_started(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 5000)
        started: list[str] = []

        found = find_or_start(str(tmp_path), launch=lambda r, i, p: started.append(r) or 1, alive=lambda url: True)

        assert found.port == 5000
        assert started == []

    def test_an_entry_that_does_not_answer_is_not_an_instance(self, tmp_path: Path) -> None:
        """Alive process, dead port: starting, wedged, or crashed short of listening. A session
        needs one that answers, so a new one is started — and its entry, not the old one, is
        what is returned."""
        instances.publish_instance(tmp_path, 5000)  # this pid, but `alive` says its port is dead
        clock = Clock()
        mine = os.getpid()

        def launch(root: str, idle: float, passthrough: list[str]) -> int:
            instances.publish_instance(root, 6000, pid=mine)  # the "new" instance re-publishes
            return mine

        answering = {6000}
        found = find_or_start(
            str(tmp_path),
            launch=launch,
            alive=lambda url: int(url.rsplit(":", 1)[1].split("/")[0]) in answering,
            clock=clock,
            poll_seconds=0,
        )

        assert found.port == 6000

    def test_a_start_that_never_answers_fails_with_where_to_look(self, tmp_path: Path) -> None:
        class TickingClock:
            """Ten fake seconds per glance, so the deadline is reached without any real waiting."""

            def __init__(self) -> None:
                self.now = 0.0

            def __call__(self) -> float:
                self.now += 10
                return self.now

        with pytest.raises(StartFailed) as failure:
            find_or_start(
                str(tmp_path), start_timeout=50, launch=lambda r, i, p: 424242, alive=lambda url: False,
                clock=TickingClock(), poll_seconds=0,
            )

        assert "424242" in str(failure.value)
        assert "logs" in str(failure.value)

    def test_the_instance_is_launched_from_this_package_not_the_installed_one(self) -> None:
        command = serve_command("/tmp/x", 30, ["--log-level", "ERROR"])

        assert command[0] == sys.executable
        assert str(PACKAGE_ROOT) in command
        assert command[command.index("serve") + 1 :][:2] == ["--project", "/tmp/x"]
        assert command[-2:] == ["--log-level", "ERROR"]


# --- two real sessions -------------------------------------------------------------------------


LAUNCH = "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('junon', run_name='__main__', alter_sys=True)"


def _attach_params(registry: Path, cwd: Path, *extra: str):  # noqa: ANN202
    from mcp import StdioServerParameters

    return StdioServerParameters(
        command=sys.executable,
        args=["-c", LAUNCH, str(PACKAGE_ROOT), "attach", "--idle-minutes", "0.1", *extra, *QUIET],
        env={**os.environ, instances.REGISTRY_ENV_VAR: str(registry)},
        cwd=str(cwd),
    )


@asynccontextmanager
async def _session(params):  # noqa: ANN001, ANN202
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(params, errlog=sys.stderr) as (read, write):
        async with ClientSession(read, write) as session:
            init = await asyncio.wait_for(session.initialize(), 60)
            yield session, init


def _text(result) -> str:  # noqa: ANN001
    return "".join(getattr(c, "text", "") for c in result.content)


async def _find_compose(session) -> str:  # noqa: ANN001
    result = await asyncio.wait_for(
        session.call_tool("find_symbol", {"name_path_pattern": "compose", "relative_path": "integrations/serena/junon/compose.py"}),
        60,
    )
    return _text(result)


def _serve_processes() -> list[psutil.Process]:
    mine = []
    for proc in psutil.process_iter(["cmdline"]):
        cmd = proc.info.get("cmdline") or []
        if "serve" in cmd and "--project" in cmd and str(REPO_ROOT) in cmd and any("junon" in c for c in cmd):
            mine.append(proc)
    return mine


class TestTwoSessions:
    """~25 s. Two stdio sessions on this repository share one instance, and survive its death."""

    def test_two_attaches_share_one_instance_and_the_second_is_quick(self, tmp_path: Path) -> None:
        before = {p.pid for p in _serve_processes()}
        instance_pid: int | None = None
        try:

            async def scenario() -> dict[str, object]:
                nonlocal instance_pid
                report: dict[str, object] = {}
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (first, init_first):
                    assert "compose" in await _find_compose(first)
                    instance = instances.instance_for(REPO_ROOT)
                    assert instance is not None
                    instance_pid = instance.pid
                    report["instructions"] = bool(init_first.instructions)
                    # Nobody's descendant: a host that kills its MCP server's process tree on exit
                    # — opencode does, measured — must not find the instance in it.
                    report["instance_parent"] = psutil.Process(instance_pid).ppid()

                    t0 = time.monotonic()
                    async with _session(_attach_params(tmp_path, REPO_ROOT)) as (second, _):
                        text = await _find_compose(second)
                        report["second_first_answer_s"] = time.monotonic() - t0
                        assert "compose" in text
                        assert instances.instance_for(REPO_ROOT).pid == instance_pid, "the second session must find the first's instance"
                        report["clients"] = len(instances.live_clients(instance_pid=instance_pid))

                        # The relayed tool list is the instance's own, not a subset.
                        relayed = {t.name for t in (await second.list_tools()).tools}
                        report["relayed_tools"] = relayed

                    # One instance for the two of them: counted in the process table, not inferred.
                    now = {p.pid for p in _serve_processes()} - before
                    report["instances_started"] = len(now)
                return report

            report = asyncio.run(scenario())
            print(f"\nsecond attach, connect to first correct answer: {report['second_first_answer_s']:.3f}s")

            assert report["instances_started"] == 1, report
            assert report["instance_parent"] == 1, f"the instance is still somebody's child: {report}"
            assert report["clients"] == 2
            assert report["instructions"] is True
            assert {"find_symbol", "activate_project", "ide_status"} <= report["relayed_tools"]  # type: ignore[operator]
            # Plan §3.2 promised "well under a second"; asserted with room for a loaded machine.
            assert report["second_first_answer_s"] < 3.0, report
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_two_sessions_starting_at_the_same_moment_still_share_one_instance(self, tmp_path: Path) -> None:
        """The race the root lock exists for: both find nothing, and without the lock both start one.

        Sequential attaches never show this — the second always finds the first's instance. Two
        started together do, within the two seconds an instance takes to answer.
        """
        before = {p.pid for p in _serve_processes()}
        try:

            async def one() -> int:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, _):
                    assert "compose" in await _find_compose(session)
                    return instances.instance_for(REPO_ROOT).pid

            async def scenario() -> tuple[int, int, int]:
                a, b = await asyncio.gather(one(), one())
                started = {p.pid for p in _serve_processes()} - before
                return a, b, len(started)

            a, b, started = asyncio.run(scenario())

            assert a == b, "the two sessions ended up on different instances"
            assert started == 1, f"{started} instances were started for one project"
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_a_session_does_not_attach_to_an_instance_running_an_older_junon(self, tmp_path: Path) -> None:
        """The loop of 2026-09-15, end to end: the card says restart the host, the host restarts,
        and it must not land back on the instance carrying the JUNON it was told to leave behind.

        A real instance is started, its registry entry is then rewritten to claim an older JUNON —
        which is precisely the state an upgrade leaves — and a real session attaches. It must get a
        second instance, and the first must still be running.
        """
        before = {p.pid for p in _serve_processes()}
        try:

            async def scenario() -> tuple[int, int, bool]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (first, _):
                    assert "compose" in await _find_compose(first)
                    stale = instances.instance_for(REPO_ROOT)
                    assert stale is not None

                    # What an upgrade looks like from the registry's side.
                    entry = tmp_path / "instances" / f"{stale.pid}.json"
                    payload = json.loads(entry.read_text())
                    payload["version"] = "0.0.1-older"
                    entry.write_text(json.dumps(payload))
                    assert instances.instance_for(REPO_ROOT) is None, "a superseded instance must not be offered"

                    async with _session(_attach_params(tmp_path, REPO_ROOT)) as (second, _):
                        assert "compose" in await _find_compose(second)
                        fresh = instances.instance_for(REPO_ROOT)
                        assert fresh is not None
                        return stale.pid, fresh.pid, psutil.pid_exists(stale.pid)

            stale_pid, fresh_pid, stale_alive = asyncio.run(scenario())

            assert fresh_pid != stale_pid, "the session reused the instance it was meant to leave"
            assert stale_alive, "the superseded instance must be left to its own sessions, not killed"
            assert len({p.pid for p in _serve_processes()} - before) == 2
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_a_session_elsewhere_reaches_this_project_through_an_explicit_root(self, tmp_path: Path) -> None:
        """Plan §3.3: project C reads A by attaching a second server to A. The working directory is
        C — a git root of its own, so cwd resolution would pick it — and `--project` names A."""
        elsewhere = tmp_path / "project-c"
        (elsewhere / ".git").mkdir(parents=True)
        before = {p.pid for p in _serve_processes()}
        try:

            async def scenario() -> tuple[str, str]:
                async with _session(_attach_params(tmp_path, elsewhere, "--project", str(REPO_ROOT))) as (session, _):
                    return await _find_compose(session), instances.instance_for(REPO_ROOT).root

            found, root = asyncio.run(scenario())

            assert "compose" in found and "integrations/serena/junon/compose.py" in found
            assert root == str(REPO_ROOT), "the instance serving the answer must be A's, not C's"
            assert instances.instance_for(elsewhere) is None, "no instance was started for C"
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_a_session_follows_its_instance_when_it_is_replaced(self, tmp_path: Path) -> None:
        """The relay reconnects, so replacing an instance is not the end of the sessions on it.

        This test asserted the opposite until 0.3.7 — that a dead instance was reported and the
        session finished. That was a deliberate decision, and it is what made a shared instance
        impossible to replace: `--stop` had to refuse every instance anyone was using, so an upgrade
        could not be applied without closing the editor someone was working in. Overturned on
        purpose; the sentence it used to assert now belongs only to a call that was in flight.
        """
        before = {p.pid for p in _serve_processes()}
        try:

            async def scenario() -> tuple[int, int, str, list[int]]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, _):
                    assert "compose" in await _find_compose(session)
                    first = instances.instance_for(REPO_ROOT).pid

                    # Killed while the session is idle, which is when a restart would happen.
                    os.kill(first, signal.SIGKILL)
                    for _ in range(60):
                        if not psutil.pid_exists(first):
                            break
                        await asyncio.sleep(0.25)
                    await asyncio.sleep(1.0)  # let the relay notice its connection has gone

                    text = await _find_compose(session)
                    second = instances.instance_for(REPO_ROOT).pid
                    # Read while the session is still up: its client entry is removed when the
                    # relay exits, so asking afterwards would always find an empty registry and
                    # this assertion would pass for the wrong reason.
                    attached = [c.instance_pid for c in instances.live_clients()]
                    return first, second, text, attached

            first, second, text, attached = asyncio.run(scenario())

            assert "compose" in text, "the call after the instance died must be answered, not refused"
            assert second != first, "it must have been answered by a new instance"
            # And the new instance must know it has a session, or it leaves at its next tick.
            assert attached == [second]
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_stopping_every_instance_leaves_the_sessions_working(self, tmp_path: Path) -> None:
        """What the dashboard button needs to be honest: `--all` with a session attached."""
        before = {p.pid for p in _serve_processes()}
        try:

            async def scenario() -> tuple[int, int, list[str], str]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, _):
                    assert "compose" in await _find_compose(session)
                    first = instances.instance_for(REPO_ROOT).pid

                    stopped, kept = instances.stop_free(including_busy=True)
                    for _ in range(60):
                        if not psutil.pid_exists(first):
                            break
                        await asyncio.sleep(0.25)
                    await asyncio.sleep(1.0)

                    text = await _find_compose(session)
                    return first, instances.instance_for(REPO_ROOT).pid, [i.root for i in kept], text

            first, second, kept, text = asyncio.run(scenario())

            assert kept == [], "--all keeps nothing back"
            assert second != first
            assert "compose" in text, "the session must survive its instance being stopped"
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)

    def test_a_call_in_flight_when_the_instance_dies_is_reported_and_never_retried(
        self, tmp_path: Path
    ) -> None:
        """The one case reconnecting must not paper over.

        A request that was in flight may have run — `replace_content` writes the file before it
        answers — so sending it again could apply an edit twice. The relay rebuilds the connection
        for everything that follows and reports this one as what it is: a call whose fate nobody
        can know. The words matter as much as the behaviour; an agent reading "it may have run"
        checks, where "failed" would make it try again.
        """
        before = {p.pid for p in _serve_processes()}
        try:

            async def scenario() -> tuple[str, bool]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, _):
                    assert "compose" in await _find_compose(session)
                    pid = instances.instance_for(REPO_ROOT).pid

                    # Killed *while* a call is out. A shell `sleep` is the only way to be sure it
                    # still is: the first version of this test used a repository-wide search, which
                    # finished before the kill landed and returned its results — a test that passed
                    # or failed on how fast the disk was that second.
                    call = asyncio.ensure_future(
                        session.call_tool("execute_shell_command", {"command": "sleep 8"})
                    )
                    await asyncio.sleep(1.5)
                    os.kill(pid, signal.SIGKILL)
                    result = await asyncio.wait_for(call, 60)
                    said = _text(result)

                    # And the session is not finished: the next call is answered by a new instance.
                    await asyncio.sleep(1.0)
                    recovered = "compose" in await _find_compose(session)
                    return said, recovered

            said, recovered = asyncio.run(scenario())

            assert "may have run" in said, said
            assert "not retried" in said or "Nothing was retried" in said, said
            assert recovered, "the session must carry on after the interrupted call"
        finally:
            for proc in _serve_processes():
                if proc.pid not in before:
                    proc.send_signal(signal.SIGTERM)
