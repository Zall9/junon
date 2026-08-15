"""IDE Bridge — Serena integration backend.

Phase 0 skeleton: typed configuration and data models only.
No network, daemon, or JSON-RPC client behavior is implemented yet.
See ``README.md`` for the intended Serena backend boundary.
"""

from __future__ import annotations

from ide_bridge.config import IdeBridgeConfig
from ide_bridge.models import (
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

__version__ = "0.0.0"

__all__ = [
    "AdapterId",
    "CapabilityDeclaration",
    "CapabilityGuarantee",
    "CapabilitySupport",
    "DocumentRevision",
    "DocumentUri",
    "ErrorResponse",
    "IdeBridgeConfig",
    "Position",
    "Range",
    "SymbolHandle",
    "WorkspaceId",
    "WorkspaceInfo",
    "__version__",
]
