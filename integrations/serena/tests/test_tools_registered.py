"""That composition actually contributes tools, judged in a fresh interpreter.

Two failure modes are guarded here, and the second was found by the first version of this file
failing to guard it.

The original test asserted that ``junon.tools`` appeared in ``tool_packages``. It passed for as long
as the module did not exist: the name was in the list, the list was correct, and no tool was ever
registered — ``tool_packages`` filters already-imported ``Tool`` subclasses, it does not import
them.

The obvious repair — assert the tools reach a built registry — was **also vacuous**, and an isolated
mutation proved it: with the import removed from ``compose`` again, all of it still passed, because
the test's own ``from junon import tools`` put the classes into ``Tool.__subclasses__()`` before it
looked. The test manufactured the condition it was checking.

So the registry is built in a subprocess that imports nothing but ``compose``. Class registration is
process-global and irreversible, which makes a fresh interpreter the only honest observer of what
composition alone achieves.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent

# Deliberately imports only `compose`. Anything else it touched would be a thing the test did for
# composition rather than a thing composition did.
PROBE = """
import json, sys
sys.path.insert(0, {root!r})
from junon.compose import compose
compose()
from serena.tools.tools_base import ToolRegistry
registry = ToolRegistry()
names = sorted(registry.get_tool_names_default_enabled())
print(json.dumps({{
    name: registry.get_tool_class_by_name(name).__module__ for name in names
}}))
"""


@pytest.fixture(scope="module")
def registered() -> dict[str, str]:
    """Tool name -> defining module, as a fresh interpreter sees it after `compose()`."""
    result = subprocess.run(
        [sys.executable, "-c", PROBE.format(root=str(PACKAGE_ROOT))],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, f"the probe failed:\n{result.stderr[-2000:]}"
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestTheToolsReachTheRegistry:
    def test_composition_contributes_tools(self, registered: dict[str, str]) -> None:
        contributed = {n for n, module in registered.items() if module.startswith("junon.")}

        assert contributed, (
            "compose() registered the package but no tool reached the registry — "
            "the phantom-package failure this file exists to catch"
        )

    def test_the_status_tool_is_offered(self, registered: dict[str, str]) -> None:
        assert "ide_status" in registered

    def test_the_symbols_tool_is_offered(self, registered: dict[str, str]) -> None:
        assert "ide_symbols_overview" in registered

    def test_the_search_tool_is_offered(self, registered: dict[str, str]) -> None:
        assert "ide_find_symbol" in registered

    def test_every_tool_the_module_defines_reaches_the_registry(
        self, registered: dict[str, str]
    ) -> None:
        """Catches a tool added to the module that never registers — a subclass without its own
        `apply`, a name collision with upstream, an import that fails silently."""
        expected = {
            "ide_status",
            "ide_symbols_overview",
            "ide_find_symbol",
            "ide_diagnostics",
            "ide_todos",
            "ide_hierarchy",
            "ide_apply_fix",
            "ide_read_document",
            "ide_read_symbol",
        }

        assert expected <= set(registered), f"missing: {sorted(expected - set(registered))}"

    def test_the_writing_tool_is_marked_as_editing(self) -> None:
        """Serena gates editing tools on a mode that permits them. A tool that writes to files
        while declaring itself read-only would slip past that gate — a read-only session would edit
        the user's code."""
        from junon.tools import IdeApplyFixTool

        assert IdeApplyFixTool.can_edit()

    def test_the_writing_tool_turns_a_stale_plan_into_a_next_step(self) -> None:
        """The three refusals `ide_apply_fix` can receive are not interchangeable.

        `STALE_DOCUMENT` means the document moved and the fix is probably still offered;
        `PRECONDITION_FAILED` means the file changed between the two phases; `PLAN_NOT_FOUND` means
        the identifier means nothing. Told only the code, an agent retries the same call or
        abandons a fix that would work a moment later. Each was live and unexplained until
        2026-08-14 — the codes were correct, and the consumer surface said nothing about them.
        """
        from junon.client import RequestFailedError
        from junon.tools import IdeApplyFixTool

        tool = IdeApplyFixTool.__new__(IdeApplyFixTool)

        stale = tool._advice(
            RequestFailedError(
                "STALE_DOCUMENT",
                "Document changed after the plan was prepared",
                details={"currentRevision": {"contentHash": "sha256:abc"}},
            )
        )
        assert "Nothing was written" in stale
        # The revision is the actionable half; the daemon computes it so a caller need not guess.
        assert "sha256:abc" in stale

        for code in ("PRECONDITION_FAILED", "PLAN_NOT_FOUND"):
            advice = tool._advice(RequestFailedError(code, code))
            assert "Nothing was written" in advice, code
            assert advice != stale, code

        # A code this route knows nothing about earns no invented guidance.
        assert tool._advice(RequestFailedError("TIMEOUT", "Request timed out")) == ""

    def test_an_ambiguous_name_is_refused_with_advice_that_can_be_followed(self) -> None:
        """Advice that loops is worse than none.

        Measured against a real IDE on 2026-08-15: `declarations` matched three declarations, two of
        them overloads in one file. The refusal said "name a file with relative_path", and following
        that advice exactly returned the identical refusal with the identical advice. Nothing in this
        tool's parameters can separate two declarations sharing a name and a file.
        """
        from junon.tools import IdeReadSymbolTool

        tool = IdeReadSymbolTool.__new__(IdeReadSymbolTool)
        tool._limit_length = lambda text, _limit: text  # type: ignore[method-assign]

        def candidate(uri: str, line: int) -> dict:
            return {
                "locator": {"name": "declarations", "kind": "function", "documentUri": uri},
                "range": {"start": {"line": line}, "end": {"line": line + 5}},
            }

        spread = tool._describe_ambiguity(
            "declarations",
            [candidate("file:///a/One.kt", 10), candidate("file:///a/Two.kt", 20)],
        )
        # Naming a file *does* narrow these, so that is what it must say — and it must not say the
        # opposite, which a single message covering both cases would.
        assert "Name a file with relative_path" in spread
        assert "cannot separate them" not in spread
        assert "One.kt" in spread and "Two.kt" in spread

        together = tool._describe_ambiguity(
            "declarations",
            [candidate("file:///a/One.kt", 10), candidate("file:///a/One.kt", 40)],
        )
        # The advice must not send the caller back to a parameter that cannot help.
        assert "relative_path cannot separate them" in together
        assert "ide_read_document" in together
        # And it still says where they are, since that is what the caller acts on.
        assert "line 11" in together and "line 41" in together

    def test_the_status_tool_says_what_each_readiness_state_means(self) -> None:
        """`ide_status` is what a caller reaches for when nothing else works.

        It reported workspaces and trust and never asked about readiness at all, so `degraded` —
        the state the JetBrains adapter began emitting on 2026-08-14 for an IDE that has stopped
        answering — was invisible exactly where it was most needed. The states are not equally
        actionable: `indexing` refuses retryably and waiting works, `degraded` may never clear on
        its own, and telling them apart is the whole value of reporting it.
        """
        from junon.tools import IdeStatusTool

        note = IdeStatusTool._readiness_note

        assert note("ready") == ""
        assert "retryabl" in note("indexing")
        assert "waiting on a dialog" in note("degraded")
        assert "retrying alone may never help" in note("degraded")
        assert note("indexing") != note("degraded")
        assert note("initializing") and note("disconnected")
        # A state this tool has never heard of earns no invented explanation.
        assert note("something-new") == ""

    def test_the_status_tool_actually_asks_the_daemon_for_readiness(self) -> None:
        """Knowing what a state means is worthless if the state is never fetched.

        The explanation above passes just as happily against a tool that reports a hardcoded
        `ready` — proved by mutation, which is why this drives `apply` and checks the call was made.
        """
        from junon.tools import IdeStatusTool

        asked: list[str] = []

        class FakeClient:
            def call(self, method: str, params: dict) -> dict:
                asked.append(method)
                if method == "workspace/list":
                    return {
                        "workspaces": [
                            {
                                "workspaceId": "ws_1",
                                "name": "demo",
                                "roots": [{"uri": "file:///demo"}],
                                "trust": "trusted",
                            }
                        ]
                    }
                return {"status": {"state": "degraded"}}

        tool = IdeStatusTool.__new__(IdeStatusTool)
        tool._client = lambda: FakeClient()  # type: ignore[method-assign]

        answer = tool.apply()

        assert "workspace/getStatus" in asked, "the tool never asked whether the IDE can answer"
        assert "readiness: degraded" in answer
        assert "waiting on a dialog" in answer

    def test_no_tool_offers_a_plan_id_across_calls(self) -> None:
        """An edit plan and an undo token both belong to the session that made them — measured, by
        preparing on one connection and being refused `PLAN_NOT_FOUND` on another. A tool taking a
        planId or an undo token as a parameter would therefore be an API that can never succeed."""
        import inspect

        from junon import tools

        for name in dir(tools):
            candidate = getattr(tools, name)
            if not (isinstance(candidate, type) and issubclass(candidate, tools.IdeBridgeTool)):
                continue
            apply_fn = candidate.__dict__.get("apply")
            if apply_fn is None:
                continue
            parameters = set(inspect.signature(apply_fn).parameters)
            offending = parameters & {"plan_id", "planId", "undo_token_id", "undoToken"}
            assert not offending, f"{name}.apply takes {offending}, which cannot survive its session"

    def test_the_tools_come_from_our_package(self, registered: dict[str, str]) -> None:
        """Guards against a name matching for some other reason than our module defining it."""
        assert registered.get("ide_status") == "junon.tools"

    def test_no_upstream_tool_was_displaced(self, registered: dict[str, str]) -> None:
        """Our tools are additive. A tool the user configured must not vanish because this package
        was installed — replacing one is a configuration decision, not a side effect of importing."""
        assert "get_symbols_overview" in registered
        assert "find_symbol" in registered
