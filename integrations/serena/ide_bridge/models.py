"""Typed data models for IDE Bridge protocol entities.

These models are the Python-side representation of IDEBP protocol types
defined in Phase 1 (JSON Schema 2020-12).  In Phase 0, only the typed
skeleton exists — no serialization, validation, or network behavior.

Key principles (from AGENTS.md §2):
- URI values are preserved as-is; no implicit conversion to local paths.
- Every edit carries revision preconditions (Phase 1+).
- Symbol handles are opaque, adapter-scoped references.

NOTE: These models intentionally have NO methods beyond ``__init__`` /
``__post_init__`` validation.  They are pure data containers.  All
behavior (serialization, mapping, network I/O) is added in later phases.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import NewType

# --- NewType wrappers for type-safety ---

#: An opaque workspace identifier assigned by the daemon.
WorkspaceId = NewType("WorkspaceId", str)

#: An opaque adapter identifier (e.g. ``"vscode"``, ``"jetbrains"``).
AdapterId = NewType("AdapterId", str)

#: A document URI.  Must be preserved as-is — never converted to a local path.
DocumentUri = NewType("DocumentUri", str)


# --- Enums ---


#: The protocol's symbol vocabulary, in schema order.
#:
#: Transcribed from ``schemas/common/symbol.schema.json`` rather than derived, because Python has no
#: generated mirror of the schemas the way Kotlin and TypeScript do. A transcription drifts, so
#: ``test_symbol_kinds.py`` reads the schema and fails when these disagree — the same content-based
#: guard the VS Code capability list uses, for the same reason.
#:
#: ``unknown`` is the protocol's own member, not a sentinel added here: it is the truthful answer for
#: a declaration whose category the IDE does not name, and callers that filter must decide what to
#: do about it rather than have it silently vanish.
SYMBOL_KINDS: tuple[str, ...] = (
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enumMember",
    "struct",
    "event",
    "operator",
    "typeParameter",
    "unknown",
)

#: The kind reported for a declaration the IDE declined to classify.
UNCLASSIFIED = "unknown"


class CapabilitySupport(str, Enum):
    """Whether a capability is supported by an adapter.

    Mirrors the IDEBP capability model (TASK.md §8):

    - ``SUPPORTED``: The adapter implements this capability.
    - ``UNSUPPORTED``: The adapter does not implement this capability.
    - ``UNKNOWN``: Capability status cannot be determined yet (e.g. dumb mode).
    """

    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"
    UNKNOWN = "unknown"


class CapabilityGuarantee(str, Enum):
    """The guarantee level of a capability.

    - ``SEMANTIC``: Full syntax-aware operation (AST/PSI-level).
    - ``SYNTACTIC``: Structural but not full semantic awareness.
    - ``TEXTUAL``: Raw text manipulation only (no syntax awareness).

    Per AGENTS.md §1: a textual edit must never be labelled ``semantic``
    or ``syntactic``.
    """

    SEMANTIC = "semantic"
    SYNTACTIC = "syntactic"
    TEXTUAL = "textual"


# --- Data models ---


@dataclass(frozen=True, slots=True)
class SymbolHandle:
    """An opaque, adapter-scoped reference to a symbol.

    Symbol handles are produced by the adapter (via the daemon) and are
    only meaningful within the session and adapter that created them.
    They are NOT portable across sessions or adapters.

    Attributes:
        handle: The opaque handle string assigned by the adapter.
        adapter_id: The adapter that created this handle.
        workspace_id: The workspace this handle belongs to.
        uri: The document URI where the symbol was resolved.
            Preserved as-is per AGENTS.md §2.
    """

    handle: str
    adapter_id: AdapterId
    workspace_id: WorkspaceId
    uri: DocumentUri

    def __post_init__(self) -> None:
        if not self.handle:
            raise ValueError("SymbolHandle.handle must be a non-empty string")
        if not self.adapter_id:
            raise ValueError("SymbolHandle.adapter_id must be a non-empty string")
        if not self.workspace_id:
            raise ValueError("SymbolHandle.workspace_id must be a non-empty string")
        if not self.uri:
            raise ValueError("SymbolHandle.uri must be a non-empty string")


@dataclass(frozen=True, slots=True)
class Position:
    """A zero-based position in a document.

    Line and character are zero-based, consistent with LSP conventions.
    Character offsets use UTF-16 code units (per TASK.md §8 / Phase 1).
    """

    line: int
    character: int

    def __post_init__(self) -> None:
        if self.line < 0:
            raise ValueError(f"Position.line must be >= 0, got {self.line}")
        if self.character < 0:
            raise ValueError(f"Position.character must be >= 0, got {self.character}")


@dataclass(frozen=True, slots=True)
class Range:
    """A range within a document, defined by start and end positions."""

    start: Position
    end: Position

    def __post_init__(self) -> None:
        # Structural validation only — no semantic range checking in Phase 0.
        # The actual start <= end check is enforced by the adapter at runtime.
        if self.start is None:
            raise ValueError("Range.start must not be None")
        if self.end is None:
            raise ValueError("Range.end must not be None")


@dataclass(frozen=True, slots=True)
class DocumentRevision:
    """A document revision precondition.

    Every edit must carry revision preconditions (AGENTS.md §2, §5).
    The daemon rejects edits when preconditions are stale.

    Attributes:
        editor_version: The editor version stamp from the IDE.
        content_hash: A hash of the document content.
        workspace_epoch: A monotonically increasing workspace epoch.
    """

    editor_version: int
    content_hash: str
    workspace_epoch: int

    def __post_init__(self) -> None:
        if self.editor_version < 0:
            raise ValueError(
                f"DocumentRevision.editor_version must be >= 0, "
                f"got {self.editor_version}"
            )
        if not self.content_hash:
            raise ValueError("DocumentRevision.content_hash must be non-empty")
        if self.workspace_epoch < 0:
            raise ValueError(
                f"DocumentRevision.workspace_epoch must be >= 0, "
                f"got {self.workspace_epoch}"
            )


@dataclass(frozen=True, slots=True)
class CapabilityDeclaration:
    """A capability declared by an adapter.

    Attributes:
        method: The IDEBP method name (e.g. ``"symbol/getDefinition"``).
        support: Whether the capability is supported.
        guarantee: The guarantee level (semantic, syntactic, textual).
        unavailable_reason:
            Human-readable reason when ``support`` is not ``SUPPORTED``.
            Empty string when the capability is supported.
    """

    method: str
    support: CapabilitySupport
    guarantee: CapabilityGuarantee
    unavailable_reason: str = ""

    def __post_init__(self) -> None:
        if not self.method:
            raise ValueError("CapabilityDeclaration.method must be non-empty")
        if self.support == CapabilitySupport.SUPPORTED and self.unavailable_reason:
            raise ValueError(
                "CapabilityDeclaration.unavailable_reason must be empty "
                "when support is SUPPORTED"
            )


@dataclass(frozen=True, slots=True)
class WorkspaceInfo:
    """Information about a registered workspace.

    Attributes:
        workspace_id: The opaque workspace identifier.
        name: A human-readable workspace name.
        root_uri: The workspace root URI.  Preserved as-is.
        adapter_id: The adapter managing this workspace.
    """

    workspace_id: WorkspaceId
    name: str
    root_uri: DocumentUri
    adapter_id: AdapterId

    def __post_init__(self) -> None:
        if not self.workspace_id:
            raise ValueError("WorkspaceInfo.workspace_id must be non-empty")
        if not self.name:
            raise ValueError("WorkspaceInfo.name must be non-empty")
        if not self.root_uri:
            raise ValueError("WorkspaceInfo.root_uri must be non-empty")
        if not self.adapter_id:
            raise ValueError("WorkspaceInfo.adapter_id must be non-empty")


@dataclass(frozen=True, slots=True)
class ErrorResponse:
    """A structured error response from the daemon or adapter.

    Attributes:
        code: The IDEBP error code (per TASK.md §14).
        message: A human-readable error message (no sensitive data).
        data: Optional structured error data.
    """

    code: str
    message: str
    data: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.code:
            raise ValueError("ErrorResponse.code must be non-empty")
        if not self.message:
            raise ValueError("ErrorResponse.message must be non-empty")
