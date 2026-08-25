"""What an `ide_*` tool says when there is no IDE to ask.

Auto-starting a headless IDE was measured and rejected — it works, and costs 2.1 GB and a Code With
Me listener per project, which is not a price worth paying for a symbol lookup. So the closed-IDE
path has to be a route rather than a dead end, and the route already existed: Serena's own tools are
backed by language servers and need no IDE at all.

The rule these tests pin is that the refusal **names the call that works**. Not "use Serena's other
tools" — that is advice, and advice is what the last two rounds of prompt edits proved gets skipped.
A named call with its parameter is something an agent makes.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from junon.client import DaemonUnavailableError, RequestFailedError
from junon.tools import (
    IdeApplyFixTool,
    IdeDiagnosticsTool,
    IdeFindSymbolTool,
    IdeHierarchyTool,
    IdeReadDocumentTool,
    IdeRefactorTool,
    IdeStatusTool,
    IdeTodosTool,
)


def explain(tool_class, error: Exception) -> str:
    tool = tool_class.__new__(tool_class)
    return tool._explain(error)


class TestWhenNoDaemonIsRunning:
    def test_the_symbol_tool_names_find_symbol(self) -> None:
        answer = explain(IdeFindSymbolTool, DaemonUnavailableError("nothing listening"))

        assert "find_symbol(name_path_pattern=...)" in answer

    def test_the_hierarchy_tool_names_both_of_its_replacements(self) -> None:
        """Callers and subtypes are two questions, and one tool does not answer both."""
        answer = explain(IdeHierarchyTool, DaemonUnavailableError("nothing listening"))

        assert "find_referencing_symbols" in answer
        assert "find_implementations" in answer

    def test_the_refusal_still_says_what_went_wrong(self) -> None:
        """The alternative is an addition, not a replacement: an agent that only learns "try this
        other tool" cannot tell a closed IDE from a broken daemon."""
        answer = explain(IdeFindSymbolTool, DaemonUnavailableError("nothing listening"))

        assert "No IDE Bridge daemon is reachable" in answer


class TestWhenNoWorkspaceCoversTheProject:
    def test_the_alternative_is_offered(self) -> None:
        """An IDE running with other projects open is the same dead end as no IDE at all."""
        answer = explain(
            IdeDiagnosticsTool,
            RequestFailedError("WORKSPACE_NOT_FOUND", "No open workspace covers /project."),
        )

        assert "get_diagnostics_for_file" in answer
        assert "WORKSPACE_NOT_FOUND" in answer

    def test_other_refusals_are_left_alone(self) -> None:
        """`CAPABILITY_UNAVAILABLE` means this IDE cannot do it — a live IDE, answering. Offering a
        language-server fallback there would bury the advice that route already gives."""
        answer = explain(
            IdeDiagnosticsTool,
            RequestFailedError("CAPABILITY_UNAVAILABLE", "no analyser for this file"),
        )

        assert "Without an IDE" not in answer


class TestWhereNothingReplacesTheIde:
    def test_a_quick_fix_has_no_equivalent_and_none_is_invented(self) -> None:
        """A quick fix comes from the IDE's inspections. Sending someone to a tool that cannot do it
        is worse than saying nothing, which is why this attribute is empty rather than hopeful."""
        answer = explain(IdeApplyFixTool, DaemonUnavailableError("nothing listening"))

        assert "Without an IDE" not in answer

    def test_the_status_tool_does_not_offer_to_replace_its_own_subject(self) -> None:
        answer = explain(IdeStatusTool, DaemonUnavailableError("nothing listening"))

        assert "Without an IDE" not in answer


class TestTheClaimsThemselves:
    @pytest.mark.parametrize(
        "tool_class, expected",
        [
            (IdeReadDocumentTool, "read_file"),
            (IdeTodosTool, "search_for_pattern"),
            (IdeRefactorTool, "rename_symbol"),
        ],
    )
    def test_each_tool_names_a_real_serena_tool(self, tool_class, expected: str) -> None:
        assert expected in tool_class.without_an_ide

    def test_the_read_tool_says_what_is_lost_by_not_using_the_ide(self) -> None:
        """`read_file` is not equivalent — it reads the disk. A fallback that hides its own cost
        teaches an agent that the IDE was never worth using."""
        assert "unsaved" in IdeReadDocumentTool.without_an_ide

    def test_the_refactor_tool_admits_which_operations_have_no_fallback(self) -> None:
        """Rename has one. Reformat and optimiseImports are the IDE's own engines, and claiming
        otherwise would send an agent to `rename_symbol` to format a file."""
        assert "no equivalent" in IdeRefactorTool.without_an_ide
