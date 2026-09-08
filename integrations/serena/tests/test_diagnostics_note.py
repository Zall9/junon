"""What the diagnostics tool says when the snapshot is incomplete.

The note is the whole value of the route on a cold file: `documents: [{diagnostics: []}]` reads as
"no problems" to anything that does not know `truncated` exists, and a caller that believes it stops
looking. So the three answers are pinned here — incomplete-and-empty, incomplete-and-partial, and
complete-and-empty — because until now nothing in this suite touched them, and a wording that turned
out to be wrong could be shipped by a green run.

One of them was: a version of this note told the caller to open the file in the IDE themselves. The
adapter opens it — `AdapterBackend.requestAnalysis` — so that advice sent an agent after something
already being done for it, and an agent cannot open an editor anyway. The assertion below is what
keeps it from coming back.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest

from junon.tools import IdeDiagnosticsTool


class FakeClient:
    """Answers `diagnostics/getSnapshot` from a script, and records what was asked."""

    def __init__(self, result: dict[str, Any]):
        self.result = result
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, params))
        return self.result


@contextmanager
def _tool_answering(result: dict[str, Any]):
    client = FakeClient(result)
    with (
        patch.object(IdeDiagnosticsTool, "_client", return_value=client),
        patch.object(IdeDiagnosticsTool, "_workspace_id", return_value="ws_test"),
        patch.object(IdeDiagnosticsTool, "get_project_root", return_value="/project"),
        patch.object(IdeDiagnosticsTool, "_limit_length", side_effect=lambda text, _: text),
    ):
        yield client


@pytest.fixture
def tool() -> IdeDiagnosticsTool:
    return IdeDiagnosticsTool.__new__(IdeDiagnosticsTool)


def _empty_document() -> dict[str, Any]:
    return {"document": {"uri": "file:///project/a.py"}, "diagnostics": []}


def test_an_empty_incomplete_snapshot_is_never_reported_as_clean(tool: IdeDiagnosticsTool) -> None:
    with _tool_answering({"documents": [_empty_document()], "truncated": True}):
        answer = json.loads(tool.apply(relative_path="a.py"))

    note = answer["incomplete_note"]
    assert "clean_note" not in answer
    assert "does not mean the file is clean" in note
    assert "ask again" in note


def test_the_note_does_not_send_the_caller_to_open_the_file(tool: IdeDiagnosticsTool) -> None:
    """The adapter opens it and starts a pass; waiting is the whole of the correct advice.

    Told to open the file, an agent either cannot comply or wastes a turn on it — and either way
    stops waiting for the answer that was already on its way.
    """
    with _tool_answering({"documents": [_empty_document()], "truncated": True}):
        answer = json.loads(tool.apply(relative_path="a.py"))

    # Lower-cased deliberately: the first version of this assertion was case-sensitive, and a probe
    # that put the old advice back as "Open the file in the IDE" walked straight through it.
    assert "open the file" not in answer["incomplete_note"].lower()


def test_an_incomplete_snapshot_that_holds_problems_says_a_different_thing(
    tool: IdeDiagnosticsTool,
) -> None:
    """`truncated` carries two facts, and overflow is the other one: problems were found and some
    were left out. Telling that caller to wait would be wrong — the answer is to narrow the ask."""
    document = {
        "document": {"uri": "file:///project/a.py"},
        "diagnostics": [{"message": "unused import", "availableFixes": []}],
    }
    with _tool_answering({"documents": [document], "truncated": True}):
        answer = json.loads(tool.apply(relative_path="a.py"))

    note = answer["incomplete_note"]
    assert "ask for a single file" in note
    assert "ask again in a few seconds" not in note


def test_a_complete_empty_snapshot_is_said_to_be_a_finding(tool: IdeDiagnosticsTool) -> None:
    """The only case where silence means something, and it has to be said out loud: otherwise the
    two empty answers are one empty answer."""
    with _tool_answering({"documents": [_empty_document()], "truncated": False}):
        answer = json.loads(tool.apply(relative_path="a.py"))

    assert "incomplete_note" not in answer
    assert "complete answer" in answer["clean_note"]
