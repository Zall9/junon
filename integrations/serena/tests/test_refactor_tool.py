"""What `ide_refactor` sends, and what it refuses to send.

The tool is the only route from Serena to the IDE's own rename engine, and the two things worth
pinning are both about *not* acting: a plan is never applied unless the caller said `confirm=True`,
and an ambiguous name is never resolved by picking one. Renaming the first of three matches would
change something nobody asked about and report success.

Upstream is faked at the session boundary — the calls the tool makes are the subject, not the
daemon's transport, which `test_client_rpc.py` already covers.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest

from junon.client import RequestFailedError
from junon.tools import IdeRefactorTool

WORKSPACE = {"workspaceId": "ws_test", "name": "p", "roots": [{"uri": "file:///project"}]}
PLAN = {
    "planId": "plan_1",
    "operation": "rename",
    "guarantee": "semantic",
    "atomicity": "semantic",
    "changes": [{"kind": "textEdit", "uri": "file:///project/a.py", "editCount": 3}],
    "warnings": [],
    "preconditions": [],
}


class FakeSession:
    """Records every call, answers from a script."""

    def __init__(self, symbols: list[dict[str, Any]] | None = None, fail: Exception | None = None):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.symbols = symbols if symbols is not None else [
            {"handle": "h1", "locator": {"name": "target", "kind": "function",
                                         "documentUri": "file:///project/a.py"}}
        ]
        self.fail = fail

    def __call__(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, params))
        if self.fail is not None and method == "workspace/applyPlan":
            raise self.fail
        return {
            "workspace/list": {"workspaces": [WORKSPACE]},
            "workspace/searchSymbols": {"symbols": self.symbols},
            "refactor/prepareRename": {"plan": PLAN},
            "refactor/prepare": {"plan": {**PLAN, "operation": "reformat"}},
            "workspace/applyPlan": {"modifiedDocuments": [{"uri": "file:///project/a.py"}]},
        }[method]

    @property
    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]


@contextmanager
def _client_returning(session: FakeSession):
    class FakeClient:
        @contextmanager
        def session(self):
            yield session

    with (
        patch.object(IdeRefactorTool, "_client", return_value=FakeClient()),
        patch.object(IdeRefactorTool, "get_project_root", return_value="/project"),
        patch.object(IdeRefactorTool, "_limit_length", side_effect=lambda text, _: text),
    ):
        yield


@pytest.fixture
def tool() -> IdeRefactorTool:
    return IdeRefactorTool.__new__(IdeRefactorTool)


def test_without_confirm_nothing_is_applied(tool: IdeRefactorTool) -> None:
    """The whole point of the flag. A preview that wrote would be the worst possible defect here."""
    session = FakeSession()

    with _client_returning(session):
        answer = json.loads(tool.apply(operation="rename", name="target", new_name="renamed"))

    assert "workspace/applyPlan" not in session.methods
    assert answer["applied"] is False
    assert answer["changes"][0]["editCount"] == 3


def test_confirm_applies_the_plan_it_showed(tool: IdeRefactorTool) -> None:
    session = FakeSession()

    with _client_returning(session):
        answer = json.loads(
            tool.apply(operation="rename", name="target", new_name="renamed", confirm=True)
        )

    assert session.methods == [
        "workspace/list",
        "workspace/searchSymbols",
        "refactor/prepareRename",
        "workspace/applyPlan",
    ]
    assert session.calls[-1][1]["planId"] == "plan_1"
    assert answer["applied"] is True
    assert answer["modifiedDocuments"] == [{"uri": "file:///project/a.py"}]


def test_the_rename_carries_the_new_name_and_both_scope_flags(tool: IdeRefactorTool) -> None:
    """Comments and strings default to off, and the daemon requires both to be stated."""
    session = FakeSession()

    with _client_returning(session):
        tool.apply(operation="rename", name="target", new_name="renamed")

    params = dict(session.calls)["refactor/prepareRename"]
    assert params["newName"] == "renamed"
    assert params["options"] == {"includeComments": False, "includeStrings": False}
    assert params["symbol"] == {"handle": "h1", "locator": session.symbols[0]["locator"]}


def test_an_ambiguous_name_is_never_resolved_by_guessing(tool: IdeRefactorTool) -> None:
    """Renaming the first of several matches changes something nobody asked about, and looks like
    success while doing it."""
    session = FakeSession(symbols=[
        {"handle": "h1", "locator": {"name": "target", "kind": "function",
                                     "documentUri": "file:///project/a.py"}},
        {"handle": "h2", "locator": {"name": "target", "kind": "class",
                                     "documentUri": "file:///project/b.py"}},
    ])

    with _client_returning(session):
        answer = tool.apply(operation="rename", name="target", new_name="renamed", confirm=True)

    assert "ambiguous" in answer
    assert "a.py" in answer and "b.py" in answer
    assert "refactor/prepareRename" not in session.methods
    assert "workspace/applyPlan" not in session.methods


def test_a_document_operation_never_searches_for_a_symbol(tool: IdeRefactorTool) -> None:
    session = FakeSession()

    with _client_returning(session):
        tool.apply(operation="reformat", relative_path="a.py", confirm=True)

    assert "workspace/searchSymbols" not in session.methods
    params = dict(session.calls)["refactor/prepare"]
    assert params["operation"] == "reformat"
    assert params["uri"].endswith("/project/a.py")


def test_a_structural_refactoring_says_why_it_is_absent(tool: IdeRefactorTool) -> None:
    """Refused by the adapters by name (ADR-0028). An agent told only "unknown operation" would try
    to reach it another way."""
    answer = tool.apply(operation="extractMethod", name="x", new_name="y")

    assert "ADR-0028" in answer
    assert "rename" in answer


def test_a_rename_missing_its_new_name_asks_rather_than_calls(tool: IdeRefactorTool) -> None:
    session = FakeSession()

    with _client_returning(session):
        answer = tool.apply(operation="rename", name="target")

    assert session.methods == []
    assert "new_name" in answer


def test_a_refused_apply_keeps_the_daemons_code_and_adds_what_to_do(tool: IdeRefactorTool) -> None:
    """`STALE_DOCUMENT` is actionable; a message that dropped the code would not be."""
    failure = RequestFailedError("STALE_DOCUMENT", "Document changed", retryable=False)
    failure.details = {"currentRevision": {"contentHash": "sha256:abc"}}
    session = FakeSession(fail=failure)

    with _client_returning(session):
        answer = tool.apply(operation="rename", name="target", new_name="renamed", confirm=True)

    assert "STALE_DOCUMENT" in answer
    assert "sha256:abc" in answer
    assert "Nothing was written" in answer
