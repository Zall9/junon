"""Opening a session must not start a project.

Measured on 2026-09-21, seconds after launching opencode: 23 shared instances, 55 language-server
children, **4.16 GB** — one per registered project, because `junon attach` started its instance at
open rather than at first use. A host launches one relay per registered project the moment it
starts; almost none of those sessions will touch their project.

What makes it possible: ten live instances across ten unrelated projects returned byte-identical
instructions and the same thirty-nine tools, so the two things a host asks at start-up can be
answered from a file keyed by JUNON version, and the project started only when something is really
asked of it.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
import pytest

from junon import handshake_cache, instances

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LAUNCH = (
    "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); "
    "runpy.run_module('junon', run_name='__main__', alter_sys=True)"
)
QUIET = ["--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"]


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


def _started_here() -> list[instances.Instance]:
    """The instances **this test** started, read from its own registry.

    Counting `junon serve` processes across the machine instead looked equivalent and was not: a
    session of the user's own agent host, making its first call on this very repository while the
    suite ran, showed up as a start attributed to the test. Two of these failed exactly that way on
    2026-09-21 and passed on a quiet machine, which is the worst kind of green. The registry is set
    to `tmp_path` for the relay and for this process alike, so what it lists is ours and nothing else
    can appear in it.
    """
    return instances.live_instances()


def _terminate_ours() -> None:
    for inst in _started_here():
        try:
            proc = psutil.Process(inst.pid)
            proc.send_signal(signal.SIGTERM)
            proc.wait(30)
        except (psutil.NoSuchProcess, psutil.TimeoutExpired):
            pass


def _attach_params(registry: Path, cwd: Path):  # noqa: ANN202
    from mcp import StdioServerParameters

    return StdioServerParameters(
        command=sys.executable,
        args=["-c", LAUNCH, str(PACKAGE_ROOT), "attach", "--idle-minutes", "0.2", *QUIET],
        env={**os.environ, instances.REGISTRY_ENV_VAR: str(registry)},
        cwd=str(cwd),
    )


@asynccontextmanager
async def _session(params, notified: list[str] | None = None):  # noqa: ANN001, ANN202
    from mcp import ClientSession, types
    from mcp.client.stdio import stdio_client

    async def watch(message) -> None:  # noqa: ANN001
        if notified is not None and isinstance(message, types.ServerNotification):
            notified.append(type(message.root).__name__)

    async with stdio_client(params, errlog=sys.stderr) as (read, write):
        async with ClientSession(read, write, message_handler=watch) as session:
            init = await asyncio.wait_for(session.initialize(), 90)
            yield session, init


def _text(result) -> str:  # noqa: ANN001
    return "".join(getattr(c, "text", "") for c in result.content)


# --- the cache itself ---------------------------------------------------------------------------


class TestTheRecordedHandshake:
    def test_what_is_written_is_what_is_read(self, tmp_path: Path) -> None:
        recorded = handshake_cache.Handshake(
            version="9.9.9",
            instructions="read the manual",
            tools=({"name": "find_symbol", "description": "x", "inputSchema": {"type": "object"}},),
            prompts=True,
            captured_from="/somewhere",
        )
        handshake_cache.write(recorded)

        assert handshake_cache.read("9.9.9") == recorded

    def test_nothing_recorded_is_none_rather_than_an_error(self) -> None:
        """A machine that has never run one must behave exactly as it did before this existed."""
        assert handshake_cache.read("0.0.0-never") is None

    @pytest.mark.parametrize(
        "content",
        [
            "{not json",
            json.dumps({"version": "9.9.9"}),
            json.dumps({"version": "9.9.9", "tools": []}),
            # A tool the SDK would refuse. Caught here rather than at `tools/list`, where it would
            # leave a session unable to list anything — worse than the eager start this replaces.
            json.dumps({"version": "9.9.9", "tools": [{"description": "no name, no schema"}]}),
        ],
    )
    def test_a_damaged_or_empty_file_is_ignored_rather_than_trusted(self, content: str) -> None:
        target = handshake_cache.path("9.9.9")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

        # Not an exception: the relay simply starts an instance, which is correct and only slower.
        assert handshake_cache.read("9.9.9") is None

    def test_a_recorded_toolset_is_one_the_sdk_accepts(self) -> None:
        """What `tools/list` will do with the file, done once at the door."""
        from mcp import types

        handshake_cache.write(
            handshake_cache.Handshake(
                version="9.9.9",
                instructions="",
                tools=({"name": "find_symbol", "description": "x", "inputSchema": {"type": "object"}},),
            )
        )
        recorded = handshake_cache.read("9.9.9")

        assert recorded is not None
        assert [types.Tool.model_validate(tool).name for tool in recorded.tools] == ["find_symbol"]

    def test_it_is_keyed_by_version_only(self) -> None:
        """Measured across ten projects: identical instructions, identical thirty-nine tools. Keying
        by project too would have meant one eager start per project after every release — the whole
        cost this removes."""
        assert handshake_cache.path("1.2.3").name == "1.2.3.json"


def _record_a_handshake() -> None:
    """Leaves a recorded handshake behind, the way any earlier session on this machine would.

    It does start an instance — there is no other way to learn what a real one answers — and stops
    it again, so the test that follows begins from an empty registry with a primed file.
    """
    if handshake_cache.read() is not None:
        return

    async def prime() -> None:
        async with _session(_attach_params(Path(os.environ[instances.REGISTRY_ENV_VAR]), REPO_ROOT)) as (session, _):
            await asyncio.wait_for(session.list_tools(), 60)

    asyncio.run(prime())
    _terminate_ours()


# --- the relay -----------------------------------------------------------------------------------


class TestOpeningStartsNothing:
    """~20 s: two real sessions, one of which must leave the machine untouched."""

    def test_a_session_that_only_lists_tools_starts_no_instance(self, tmp_path: Path) -> None:
        assert _started_here() == [], "the registry must start empty for the count to mean anything"
        try:

            async def prime() -> list[str]:
                # The first session has nothing recorded, so it starts an instance and records.
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, init):
                    tools = await asyncio.wait_for(session.list_tools(), 60)
                    assert init.instructions, "the instructions must survive the change"
                    return sorted(t.name for t in tools.tools)

            primed = asyncio.run(prime())
            assert handshake_cache.read() is not None, "the first session must record the handshake"
            assert len(_started_here()) == 1, "the unrecorded first session does start one"
            _terminate_ours()

            async def second() -> tuple[list[str], str | None, int]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, init):
                    tools = await asyncio.wait_for(session.list_tools(), 60)
                    return sorted(t.name for t in tools.tools), init.instructions, len(_started_here())

            names, instructions, running = asyncio.run(second())

            assert running == 0, "opening and listing tools must start no instance at all"
            assert names == primed, "the cached tool list must be the instance's own"
            assert instructions, "and so must the instructions"
        finally:
            _terminate_ours()

    def test_the_first_tool_call_starts_exactly_one_and_answers(self, tmp_path: Path) -> None:
        assert _started_here() == [], "the registry must start empty for the count to mean anything"
        try:
            _record_a_handshake()  # as an earlier session on this machine would have left it

            async def scenario() -> tuple[int, int, str]:
                async with _session(_attach_params(tmp_path, REPO_ROOT)) as (session, _):
                    await asyncio.wait_for(session.list_tools(), 60)
                    idle = len(_started_here())

                    result = await asyncio.wait_for(
                        session.call_tool(
                            "find_symbol",
                            {
                                "name_path_pattern": "compose",
                                "relative_path": "integrations/serena/junon/compose.py",
                            },
                        ),
                        120,
                    )
                    return idle, len(_started_here()), _text(result)

            idle, after_call, text = asyncio.run(scenario())

            assert idle == 0, "listing tools against a recorded handshake starts nothing"
            assert after_call == 1, "the first call must start exactly one instance"
            assert "compose" in text, "and the answer must be the real one"
        finally:
            _terminate_ours()


class TestWhatTheHostIsTold:
    def test_a_correct_cache_says_nothing_to_the_host(self, tmp_path: Path) -> None:
        """`tools/list_changed` has to keep meaning something.

        The relay opens its upstream deliberately on first use. Leaving the call path to discover
        that it has no session would reach the same instance — by way of *reconnection*, which tells
        the host its toolset changed and logs an instance change that never happened. Once per
        session, on every first call. The mutation that removes the deliberate open leaves every
        other assertion in this file green, which is why this test exists.
        """
        assert _started_here() == [], "the registry must start empty for the count to mean anything"
        try:
            _record_a_handshake()
            notified: list[str] = []

            async def scenario() -> str:
                async with _session(_attach_params(tmp_path, REPO_ROOT), notified) as (session, _):
                    await asyncio.wait_for(session.list_tools(), 60)
                    result = await asyncio.wait_for(
                        session.call_tool(
                            "find_symbol",
                            {
                                "name_path_pattern": "compose",
                                "relative_path": "integrations/serena/junon/compose.py",
                            },
                        ),
                        120,
                    )
                    await asyncio.sleep(0.5)  # a notification in flight would arrive by now
                    return _text(result)

            text = asyncio.run(scenario())

            assert "compose" in text
            assert "ToolListChangedNotification" not in notified, (
                f"the host was told its tools changed when nothing did: {notified}"
            )
        finally:
            _terminate_ours()


class TestAStaleCacheCorrectsItself:
    def test_a_wrong_recorded_toolset_is_rewritten_on_first_use(self, tmp_path: Path) -> None:
        """The safety net that makes keying by version alone defensible."""
        assert _started_here() == [], "the registry must start empty for the count to mean anything"
        try:
            handshake_cache.write(
                handshake_cache.Handshake(
                    version=instances.running_version(),
                    instructions="stale instructions",
                    tools=({"name": "a_tool_that_does_not_exist", "description": "", "inputSchema": {"type": "object"}},),
                )
            )

            notified: list[str] = []

            async def scenario() -> tuple[list[str], str]:
                async with _session(_attach_params(tmp_path, REPO_ROOT), notified) as (session, _):
                    listed = sorted(t.name for t in (await asyncio.wait_for(session.list_tools(), 60)).tools)
                    result = await asyncio.wait_for(
                        session.call_tool(
                            "find_symbol",
                            {
                                "name_path_pattern": "compose",
                                "relative_path": "integrations/serena/junon/compose.py",
                            },
                        ),
                        120,
                    )
                    await asyncio.sleep(0.5)  # give the notification time to arrive
                    return listed, _text(result)

            listed, text = asyncio.run(scenario())

            assert listed == ["a_tool_that_does_not_exist"], "the stale list is what start-up served"
            assert "compose" in text, "the call still reaches the real instance"
            rewritten = handshake_cache.read()
            assert rewritten is not None
            assert "find_symbol" in rewritten.tool_names(), "the file must be corrected by first use"
            assert "a_tool_that_does_not_exist" not in rewritten.tool_names()
            assert "ToolListChangedNotification" in notified, (
                "the host served a stale list must be told to ask again"
            )
        finally:
            _terminate_ours()
