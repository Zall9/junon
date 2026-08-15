"""Smoke tests for IDE Bridge protocol data models.

These tests verify that the typed models:
- Accept valid inputs.
- Reject invalid inputs at construction time.
- Are immutable (frozen=True).
- Preserve URI values as-is (no path conversion).
- Enforce the guarantee/support invariant for CapabilityDeclaration.
"""

from __future__ import annotations

import dataclasses

import pytest

from ide_bridge.models import (
    AdapterId,
    CapabilityDeclaration,
    CapabilityGuarantee,
    CapabilitySupport,
    DocumentUri,
    DocumentRevision,
    ErrorResponse,
    Position,
    Range,
    SymbolHandle,
    WorkspaceId,
    WorkspaceInfo,
)


class TestNewTypes:
    """Verify that NewType wrappers exist and are usable."""

    def test_workspace_id_is_str(self) -> None:
        wid = WorkspaceId("ws-123")
        assert wid == "ws-123"
        assert isinstance(wid, str)

    def test_adapter_id_is_str(self) -> None:
        aid = AdapterId("vscode")
        assert aid == "vscode"
        assert isinstance(aid, str)

    def test_document_uri_is_str(self) -> None:
        uri = DocumentUri("file:///project/src/main.py")
        assert uri == "file:///project/src/main.py"
        assert isinstance(uri, str)


class TestEnums:
    """Verify enum values and string behavior."""

    def test_capability_support_values(self) -> None:
        assert CapabilitySupport.SUPPORTED == "supported"
        assert CapabilitySupport.UNSUPPORTED == "unsupported"
        assert CapabilitySupport.UNKNOWN == "unknown"

    def test_capability_guarantee_values(self) -> None:
        assert CapabilityGuarantee.SEMANTIC == "semantic"
        assert CapabilityGuarantee.SYNTACTIC == "syntactic"
        assert CapabilityGuarantee.TEXTUAL == "textual"

    def test_guarantee_distinct_values(self) -> None:
        """All guarantee levels are distinct (no overlap)."""
        values = {g.value for g in CapabilityGuarantee}
        assert len(values) == 3

    def test_support_distinct_values(self) -> None:
        values = {s.value for s in CapabilitySupport}
        assert len(values) == 3


class TestPosition:
    """Tests for the Position model."""

    def test_valid_position(self) -> None:
        pos = Position(line=0, character=0)
        assert pos.line == 0
        assert pos.character == 0

    def test_non_zero_position(self) -> None:
        pos = Position(line=10, character=25)
        assert pos.line == 10
        assert pos.character == 25

    def test_negative_line_rejected(self) -> None:
        with pytest.raises(ValueError, match="Position.line"):
            Position(line=-1, character=0)

    def test_negative_character_rejected(self) -> None:
        with pytest.raises(ValueError, match="Position.character"):
            Position(line=0, character=-1)

    def test_is_frozen(self) -> None:
        pos = Position(line=0, character=0)
        with pytest.raises(dataclasses.FrozenInstanceError):
            pos.line = 5  # type: ignore[misc]


class TestRange:
    """Tests for the Range model."""

    def test_valid_range(self) -> None:
        r = Range(start=Position(0, 0), end=Position(0, 10))
        assert r.start.line == 0
        assert r.end.character == 10

    def test_is_frozen(self) -> None:
        r = Range(start=Position(0, 0), end=Position(0, 10))
        with pytest.raises(dataclasses.FrozenInstanceError):
            r.start = Position(1, 1)  # type: ignore[misc]


class TestSymbolHandle:
    """Tests for the SymbolHandle model."""

    def test_valid_handle(self) -> None:
        h = SymbolHandle(
            handle="sym-abc",
            adapter_id=AdapterId("vscode"),
            workspace_id=WorkspaceId("ws-1"),
            uri=DocumentUri("file:///project/src/main.py"),
        )
        assert h.handle == "sym-abc"
        assert h.adapter_id == "vscode"
        assert h.workspace_id == "ws-1"
        assert h.uri == "file:///project/src/main.py"

    def test_empty_handle_rejected(self) -> None:
        with pytest.raises(ValueError, match="handle"):
            SymbolHandle(
                handle="",
                adapter_id=AdapterId("vscode"),
                workspace_id=WorkspaceId("ws-1"),
                uri=DocumentUri("file:///x"),
            )

    def test_empty_adapter_rejected(self) -> None:
        with pytest.raises(ValueError, match="adapter_id"):
            SymbolHandle(
                handle="sym",
                adapter_id=AdapterId(""),
                workspace_id=WorkspaceId("ws-1"),
                uri=DocumentUri("file:///x"),
            )

    def test_remote_uri_preserved(self) -> None:
        """URI values must be preserved as-is (AGENTS.md §2)."""
        remote_uri = DocumentUri("ssh://host/path/to/file")
        h = SymbolHandle(
            handle="sym",
            adapter_id=AdapterId("jetbrains"),
            workspace_id=WorkspaceId("ws-1"),
            uri=remote_uri,
        )
        assert h.uri == "ssh://host/path/to/file"
        assert h.uri == remote_uri

    def test_is_frozen(self) -> None:
        h = SymbolHandle(
            handle="sym",
            adapter_id=AdapterId("vscode"),
            workspace_id=WorkspaceId("ws-1"),
            uri=DocumentUri("file:///x"),
        )
        with pytest.raises(dataclasses.FrozenInstanceError):
            h.handle = "other"  # type: ignore[misc]


class TestDocumentRevision:
    """Tests for the DocumentRevision model."""

    def test_valid_revision(self) -> None:
        rev = DocumentRevision(editor_version=5, content_hash="sha256:abc", workspace_epoch=1)
        assert rev.editor_version == 5
        assert rev.content_hash == "sha256:abc"
        assert rev.workspace_epoch == 1

    def test_negative_editor_version_rejected(self) -> None:
        with pytest.raises(ValueError, match="editor_version"):
            DocumentRevision(editor_version=-1, content_hash="h", workspace_epoch=0)

    def test_empty_content_hash_rejected(self) -> None:
        with pytest.raises(ValueError, match="content_hash"):
            DocumentRevision(editor_version=0, content_hash="", workspace_epoch=0)

    def test_negative_workspace_epoch_rejected(self) -> None:
        with pytest.raises(ValueError, match="workspace_epoch"):
            DocumentRevision(editor_version=0, content_hash="h", workspace_epoch=-1)


class TestCapabilityDeclaration:
    """Tests for the CapabilityDeclaration model."""

    def test_supported_capability(self) -> None:
        cap = CapabilityDeclaration(
            method="symbol/getDefinition",
            support=CapabilitySupport.SUPPORTED,
            guarantee=CapabilityGuarantee.SEMANTIC,
        )
        assert cap.method == "symbol/getDefinition"
        assert cap.support == CapabilitySupport.SUPPORTED
        assert cap.guarantee == CapabilityGuarantee.SEMANTIC
        assert cap.unavailable_reason == ""

    def test_unsupported_with_reason(self) -> None:
        cap = CapabilityDeclaration(
            method="symbol/editRegion",
            support=CapabilitySupport.UNSUPPORTED,
            guarantee=CapabilityGuarantee.TEXTUAL,
            unavailable_reason="Not implemented in this adapter",
        )
        assert cap.support == CapabilitySupport.UNSUPPORTED
        assert cap.unavailable_reason == "Not implemented in this adapter"

    def test_supported_with_reason_rejected(self) -> None:
        """A supported capability must not have an unavailable_reason (invariant)."""
        with pytest.raises(ValueError, match="unavailable_reason"):
            CapabilityDeclaration(
                method="symbol/getDefinition",
                support=CapabilitySupport.SUPPORTED,
                guarantee=CapabilityGuarantee.SEMANTIC,
                unavailable_reason="This should not be here",
            )

    def test_empty_method_rejected(self) -> None:
        with pytest.raises(ValueError, match="method"):
            CapabilityDeclaration(
                method="",
                support=CapabilitySupport.SUPPORTED,
                guarantee=CapabilityGuarantee.SEMANTIC,
            )

    def test_textual_never_labelled_semantic(self) -> None:
        """AGENTS.md §1: textual edit must never be labelled semantic."""
        cap = CapabilityDeclaration(
            method="workspace/applyPlan",
            support=CapabilitySupport.SUPPORTED,
            guarantee=CapabilityGuarantee.TEXTUAL,
        )
        assert cap.guarantee == CapabilityGuarantee.TEXTUAL
        assert cap.guarantee != CapabilityGuarantee.SEMANTIC


class TestWorkspaceInfo:
    """Tests for the WorkspaceInfo model."""

    def test_valid_workspace(self) -> None:
        ws = WorkspaceInfo(
            workspace_id=WorkspaceId("ws-1"),
            name="My Project",
            root_uri=DocumentUri("file:///home/user/project"),
            adapter_id=AdapterId("vscode"),
        )
        assert ws.workspace_id == "ws-1"
        assert ws.name == "My Project"
        assert ws.root_uri == "file:///home/user/project"
        assert ws.adapter_id == "vscode"

    def test_empty_workspace_id_rejected(self) -> None:
        with pytest.raises(ValueError, match="workspace_id"):
            WorkspaceInfo(
                workspace_id=WorkspaceId(""),
                name="x",
                root_uri=DocumentUri("file:///x"),
                adapter_id=AdapterId("vscode"),
            )

    def test_remote_root_uri_preserved(self) -> None:
        """Workspace root URIs must be preserved (AGENTS.md §2)."""
        ws = WorkspaceInfo(
            workspace_id=WorkspaceId("ws-1"),
            name="Remote",
            root_uri=DocumentUri("ssh://dev-server/home/user/project"),
            adapter_id=AdapterId("jetbrains"),
        )
        assert ws.root_uri == "ssh://dev-server/home/user/project"


class TestErrorResponse:
    """Tests for the ErrorResponse model."""

    def test_valid_error(self) -> None:
        err = ErrorResponse(code="PRECONDITION_FAILED", message="Document is stale")
        assert err.code == "PRECONDITION_FAILED"
        assert err.message == "Document is stale"
        assert err.data == {}

    def test_error_with_data(self) -> None:
        err = ErrorResponse(
            code="CAPABILITY_UNAVAILABLE",
            message="symbol/getDefinition is not supported",
            data={"method": "symbol/getDefinition"},
        )
        assert err.data == {"method": "symbol/getDefinition"}

    def test_empty_code_rejected(self) -> None:
        with pytest.raises(ValueError, match="code"):
            ErrorResponse(code="", message="x")

    def test_empty_message_rejected(self) -> None:
        with pytest.raises(ValueError, match="message"):
            ErrorResponse(code="ERR", message="")


class TestPackagePublicAPI:
    """Verify that __init__.py re-exports are correct."""

    def test_version_is_string(self) -> None:
        import ide_bridge

        assert isinstance(ide_bridge.__version__, str)
        assert ide_bridge.__version__ == "0.0.0"

    def test_public_api_exports(self) -> None:
        import ide_bridge

        for name in ide_bridge.__all__:
            assert hasattr(ide_bridge, name), f"Missing public export: {name}"

    def test_config_importable(self) -> None:
        from ide_bridge import IdeBridgeConfig

        config = IdeBridgeConfig()
        assert config.request_timeout_seconds == 30

    def test_models_importable(self) -> None:
        from ide_bridge import (
            AdapterId,
            CapabilityDeclaration,
            CapabilityGuarantee,
            CapabilitySupport,
            DocumentRevision,
            DocumentUri,
            ErrorResponse,
            Position,
            Range,
            SymbolHandle,
            WorkspaceId,
            WorkspaceInfo,
        )

        assert CapabilitySupport.SUPPORTED == "supported"
        assert CapabilityGuarantee.SEMANTIC == "semantic"
        assert Position(line=0, character=0).line == 0
        assert Range(start=Position(0, 0), end=Position(0, 10)).end.character == 10
        assert (
            DocumentRevision(
                editor_version=0, content_hash="h", workspace_epoch=0
            ).content_hash
            == "h"
        )
        assert (
            CapabilityDeclaration(
                method="symbol/getDefinition",
                support=CapabilitySupport.SUPPORTED,
                guarantee=CapabilityGuarantee.SEMANTIC,
            ).method
            == "symbol/getDefinition"
        )
        assert (
            WorkspaceInfo(
                workspace_id=WorkspaceId("ws-1"),
                name="x",
                root_uri=DocumentUri("file:///x"),
                adapter_id=AdapterId("vscode"),
            ).name
            == "x"
        )
        assert ErrorResponse(code="ERR", message="m").code == "ERR"
