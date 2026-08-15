"""Typed configuration model for the IDE Bridge Serena backend.

This module defines the configuration shape that Phase 6 will use to
connect to the IDE Bridge daemon.  In Phase 0, only the data model
exists — no I/O, no network, no file reading, no environment parsing.

The configuration mirrors the YAML structure described in TASK.md §21::

    ide_bridge:
      discovery_file: auto
      workspace: auto
      request_timeout_seconds: 30
      prefer_adapter:
        - jetbrains
        - vscode
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Union

from ide_bridge.models import AdapterId

# --- Sentinel types ---

#: ``"auto"`` means: auto-detect (read discovery file from the default location).
AutoSentinel = Literal["auto"]

#: A path can be ``"auto"`` (auto-detect) or an explicit string path.
PathSpec = Union[AutoSentinel, str]

#: A workspace can be ``"auto"`` (match the Serena project root) or an explicit workspace ID.
WorkspaceSpec = Union[AutoSentinel, str]

#: Default request timeout in seconds, per TASK.md §21.
DEFAULT_REQUEST_TIMEOUT_SECONDS: int = 30

#: Default adapter preference order, per TASK.md §21.
DEFAULT_PREFER_ADAPTER: tuple[AdapterId, ...] = (
    AdapterId("jetbrains"),
    AdapterId("vscode"),
)


@dataclass(frozen=True, slots=True)
class IdeBridgeConfig:
    """Immutable configuration for the IDE Bridge backend.

    Attributes:
        discovery_file:
            ``"auto"`` to auto-detect the discovery file, or an explicit
            path string.  No path resolution or I/O happens in Phase 0.
        workspace:
            ``"auto"`` to match the Serena project root at runtime, or an
            explicit workspace identifier.
        request_timeout_seconds:
            Per-request timeout in seconds.  Must be a positive integer.
        prefer_adapter:
            Ordered list of preferred adapter IDs.  The backend tries
            adapters in this order when multiple are available.
    """

    discovery_file: PathSpec = "auto"
    workspace: WorkspaceSpec = "auto"
    request_timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS
    prefer_adapter: tuple[AdapterId, ...] = field(
        default_factory=lambda: DEFAULT_PREFER_ADAPTER
    )

    def __post_init__(self) -> None:
        """Validate configuration values at construction time."""
        if self.request_timeout_seconds <= 0:
            raise ValueError(
                f"request_timeout_seconds must be a positive integer, "
                f"got {self.request_timeout_seconds}"
            )
        if not self.prefer_adapter:
            raise ValueError("prefer_adapter must not be empty")
        # adapter IDs must be non-empty strings
        for adapter_id in self.prefer_adapter:
            if not isinstance(adapter_id, str) or not adapter_id.strip():
                raise ValueError(
                    f"prefer_adapter entries must be non-empty strings, "
                    f"got {adapter_id!r}"
                )


def default_config() -> IdeBridgeConfig:
    """Return the default configuration matching TASK.md §21."""
    return IdeBridgeConfig()
