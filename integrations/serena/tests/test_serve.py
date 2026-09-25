"""``junon serve``: the pin, the idle exit, and the process that does both for real.

The first two are decided without a process — a pinned tool and a watchdog with its clock and its
registry handed in — because the rules are small and every one of them has to be seen failing. The
last starts the real command against this repository and watches it announce itself, refuse another
project, and leave on its own with its language servers, which is the whole promise of
``docs/SHARED_JUNON_PLAN.md`` Phase 1 and cannot be shown any other way.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

from junon import instances
from junon.serve import IdleWatchdog, parse, pin, serena_argv

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]

#: Runs the `junon` package that sits beside this file — not whichever one is installed.
#:
#: `python -m junon` resolves through the editable install to the checkout, which is right until
#: the suite runs on a copy: a mutation probe then exercises the real sources and reports on the
#: wrong tree. Measured: `PYTHONPATH` does not beat the editable finder here; an explicit
#: `sys.path.insert(0, …)` does. ADR-0037 in miniature — name the code that answered.
LAUNCH_BESIDE_THIS_FILE = (
    "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); "
    "runpy.run_module('junon', run_name='__main__', alter_sys=True)"
)


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


# --- the pin -----------------------------------------------------------------------------------


class FakeAgent:
    def __init__(self, name: str) -> None:
        self.activated: list[str] = []
        self._name = name

    def get_active_project(self):  # noqa: ANN201
        return SimpleNamespace(project_name=self._name)

    def activate_project_from_path_or_name(self, project: str) -> bool:
        self.activated.append(project)
        return False

    def get_project_activation_message(self, session_id: str) -> str:
        return f"activated for {session_id}"


@pytest.fixture
def pinned(tmp_path: Path):
    undo = pin(tmp_path)
    yield tmp_path
    undo()


def _tool(agent: FakeAgent):  # noqa: ANN202
    from serena.tools.config_tools import ActivateProjectTool

    tool = ActivateProjectTool.__new__(ActivateProjectTool)
    tool.agent = agent
    return tool


class TestPin:
    def test_another_project_is_refused_and_told_where_to_go(self, pinned: Path, tmp_path: Path) -> None:
        agent = FakeAgent("here")
        other = tmp_path.parent / "elsewhere"

        answer = _tool(agent).apply(str(other), "session")

        assert agent.activated == [], "a refusal that still switched the project is the trap itself"
        assert str(pinned.resolve()) in answer
        assert f"junon attach --project {other}" in answer

    def test_the_pinned_project_by_path_still_reaches_upstream(self, pinned: Path) -> None:
        agent = FakeAgent("here")

        answer = _tool(agent).apply(str(pinned / "sub" / ".."), "session")

        assert agent.activated == [str(pinned / "sub" / "..")]
        assert "activated for session" in answer

    def test_the_pinned_project_by_registered_name_still_reaches_upstream(self, pinned: Path) -> None:
        """Sessions ask by name as often as by path; the name is only known to the agent."""
        agent = FakeAgent("here")

        answer = _tool(agent).apply("here", "session")

        assert agent.activated == ["here"]
        assert "activated for session" in answer

    def test_the_pinned_tool_keeps_upstreams_docstring_and_signature(self, pinned: Path) -> None:
        """Serena builds the MCP schema from these, per connection, inside the server lifespan.

        The first version of the pin dropped them, and every `initialize` against the instance
        hung: the port listened, no session ever opened, nothing was logged. A schema the server
        cannot build is a server that cannot say hello.
        """
        import inspect

        from serena.tools.config_tools import ActivateProjectTool

        tool = ActivateProjectTool.__new__(ActivateProjectTool)
        assert "Activates the project" in (tool.get_apply_docstring() or "")
        assert list(inspect.signature(ActivateProjectTool.apply).parameters) == ["self", "project", "session_id"]

    def test_undo_puts_the_original_back(self, tmp_path: Path) -> None:
        from serena.tools.config_tools import ActivateProjectTool

        original = ActivateProjectTool.__dict__["apply"]
        undo = pin(tmp_path)
        assert ActivateProjectTool.__dict__["apply"] is not original
        undo()

        assert ActivateProjectTool.__dict__["apply"] is original


# --- the watchdog ------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class TestIdleWatchdog:
    def test_nobody_attached_for_the_idle_period_ends_the_instance(self) -> None:
        clock = Clock()
        ended: list[bool] = []
        dog = IdleWatchdog(idle_seconds=60, clients=lambda: 0, on_idle=lambda: ended.append(True), clock=clock)

        clock.now += 59
        assert dog.tick() is False and ended == []
        clock.now += 1
        assert dog.tick() is True and ended == [True]

    def test_an_attached_session_keeps_it_alive_and_restarts_the_clock(self) -> None:
        clock = Clock()
        attached = {"n": 1}
        ended: list[bool] = []
        dog = IdleWatchdog(idle_seconds=60, clients=lambda: attached["n"], on_idle=lambda: ended.append(True), clock=clock)

        clock.now += 59
        assert dog.tick() is False  # a session is there: busy
        attached["n"] = 0
        clock.now += 59  # 118 s since start, 59 s since the session was last seen
        assert dog.tick() is False and ended == []
        clock.now += 1
        assert dog.tick() is True and ended == [True]

    def test_a_free_instance_whose_code_is_superseded_goes_at_once(self) -> None:
        """Why an upgrade looked as if it had not taken: nobody was using this process, nobody ever
        would — a new session will not attach to superseded code — and it still sat there for the
        whole idle period."""
        clock = Clock()
        ended: list[bool] = []
        dog = IdleWatchdog(
            idle_seconds=1800, clients=lambda: 0, on_idle=lambda: ended.append(True),
            clock=clock, superseded=lambda: True,
        )

        assert dog.tick() is True and ended == [True], "it must not wait out the idle period"

    def test_a_session_outranks_a_version(self) -> None:
        """The trade that must not be made: cutting someone's live connection to install a number."""
        clock = Clock()
        ended: list[bool] = []
        dog = IdleWatchdog(
            idle_seconds=60, clients=lambda: 1, on_idle=lambda: ended.append(True),
            clock=clock, superseded=lambda: True,
        )

        clock.now += 10_000
        assert dog.tick() is False and ended == []

    def test_a_current_instance_still_gets_its_full_idle_period(self) -> None:
        """The rule this must not have quietly replaced."""
        clock = Clock()
        ended: list[bool] = []
        dog = IdleWatchdog(
            idle_seconds=60, clients=lambda: 0, on_idle=lambda: ended.append(True),
            clock=clock, superseded=lambda: False,
        )

        clock.now += 59
        assert dog.tick() is False and ended == []
        clock.now += 1
        assert dog.tick() is True

    def test_the_check_interval_follows_the_idle_period_within_bounds(self) -> None:
        assert IdleWatchdog(600, lambda: 0, lambda: None).interval_seconds == 60
        assert IdleWatchdog(3, lambda: 0, lambda: None).interval_seconds == 0.5
        assert IdleWatchdog(100, lambda: 0, lambda: None).interval_seconds == 10


# --- the command line --------------------------------------------------------------------------


class TestArguments:
    def test_serena_gets_the_transport_the_port_and_the_pinned_root_plus_whatever_else(self) -> None:
        options, rest = parse(["--project", "/tmp", "--port", "4242", "--enable-web-dashboard", "false"])

        argv = serena_argv(options, 4242, rest)

        assert argv[:2] == ["junon", "start-mcp-server"]
        assert argv[argv.index("--transport") + 1] == "streamable-http"
        assert argv[argv.index("--port") + 1] == "4242"
        assert argv[argv.index("--project") + 1] == instances.normalise_root("/tmp")
        assert argv[-2:] == ["--enable-web-dashboard", "false"], "Serena's own flags pass through untouched"

    def test_an_instance_never_opens_a_browser_unless_asked(self) -> None:
        """A shared instance starts in the background for whichever session needed it; Serena's
        configuration opened a tab each time — one every two minutes on 2026-09-25."""
        options, rest = parse(["--project", "/tmp"])
        argv = serena_argv(options, 4242, rest)
        assert argv[argv.index("--open-web-dashboard") + 1] == "false"

        # Asked for explicitly, it still opens: the passthrough comes after, and the last one wins.
        options, rest = parse(["--project", "/tmp", "--open-web-dashboard", "true"])
        argv = serena_argv(options, 4242, rest)
        assert argv[-2:] == ["--open-web-dashboard", "true"]
        assert argv.index("--open-web-dashboard") < len(argv) - 2

    def test_the_idle_period_defaults_to_thirty_minutes(self) -> None:
        options, _ = parse(["--project", "/tmp"])
        assert options.idle_minutes == 30.0


# --- the real thing ----------------------------------------------------------------------------


def _wait_for(predicate, timeout: float, what: str):  # noqa: ANN001, ANN202
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    raise AssertionError(f"timed out after {timeout}s waiting for {what}")


def _call(url: str, tool: str, arguments: dict) -> str:  # noqa: ANN401
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async def go() -> str:
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool, arguments)
                return "".join(getattr(c, "text", "") for c in result.content)

    # Bounded, because the failure this file once met was a server that listened and never
    # answered — and a test that hangs reports nothing.
    return asyncio.run(asyncio.wait_for(go(), 20))


class TestServeProcess:
    """~15 s: a real instance on this repository, three idle seconds, watched to the end."""

    def test_it_announces_itself_refuses_another_project_and_leaves_when_unused(
        self, tmp_path: Path
    ) -> None:
        proc = subprocess.Popen(
            [
                sys.executable, "-c", LAUNCH_BESIDE_THIS_FILE, str(PACKAGE_ROOT),
                "serve", "--project", str(REPO_ROOT), "--idle-minutes", "0.05",
                "--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR",
            ],
            env={**os.environ, instances.REGISTRY_ENV_VAR: str(tmp_path)},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            # Announced, with a root two processes agree on and a port that answers.
            instance = _wait_for(lambda: instances.instance_for(REPO_ROOT), 30, "the instance entry")
            assert instance.pid == proc.pid

            def answers() -> bool:
                try:
                    return "Serena" in _call(instance.url, "get_current_config", {})
                except Exception:  # noqa: BLE001 - not listening yet
                    return False

            # A client entry for this test holds the instance while it is being examined; without
            # it, three idle seconds may run out under a slow language-server start.
            instances.publish_client(REPO_ROOT, instance_pid=proc.pid)
            _wait_for(answers, 30, "the MCP endpoint")

            # Pinned: another project is refused, and the message says so.
            refusal = _call(instance.url, "activate_project", {"project": str(tmp_path)})
            assert "pinned to" in refusal and str(REPO_ROOT) in refusal

            # Held: past twice the idle period it is still there, because a session is attached.
            children = psutil.Process(proc.pid).children(recursive=True)
            assert children, "no language server was started, so the survivors check below proves nothing"
            time.sleep(7)
            assert proc.poll() is None, "an instance with a live client must not leave"

            # Released: with the client gone it exits by itself, entry removed, language servers too.
            instances.unpublish_client()
            _wait_for(lambda: proc.poll() is not None, 20, "the instance to exit on its own")
            assert instances.instance_for(REPO_ROOT) is None
            time.sleep(1)
            survivors = [c.pid for c in children if psutil.pid_exists(c.pid)]
            assert survivors == [], "an idle exit that leaves language servers behind is the sprawl renamed"
        finally:
            if proc.poll() is None:
                proc.kill()
