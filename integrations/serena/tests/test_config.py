"""Smoke tests for the IdeBridgeConfig model.

These tests verify that the configuration dataclass:
- Has the correct default values matching TASK.md §21.
- Validates invalid values at construction time.
- Is immutable (frozen=True).
- Supports custom configurations.
"""

from __future__ import annotations

import dataclasses

import pytest

from ide_bridge.config import (
    DEFAULT_PREFER_ADAPTER,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    IdeBridgeConfig,
    default_config,
)


class TestDefaultConfig:
    """Tests for the default configuration."""

    def test_default_config_values(self) -> None:
        """default_config() matches the TASK.md §21 proposed configuration."""
        config = default_config()
        assert config.discovery_file == "auto"
        assert config.workspace == "auto"
        assert config.request_timeout_seconds == DEFAULT_REQUEST_TIMEOUT_SECONDS
        assert config.prefer_adapter == DEFAULT_PREFER_ADAPTER

    def test_default_config_is_frozen(self) -> None:
        """Config instances are immutable."""
        config = default_config()
        with pytest.raises(dataclasses.FrozenInstanceError):
            config.discovery_file = "/explicit/path"  # type: ignore[misc]

    def test_default_timeout_is_30(self) -> None:
        """TASK.md §21 specifies request_timeout_seconds: 30."""
        assert DEFAULT_REQUEST_TIMEOUT_SECONDS == 30

    def test_default_prefer_adapter_order(self) -> None:
        """TASK.md §21 prefers jetbrains before vscode."""
        assert DEFAULT_PREFER_ADAPTER == ("jetbrains", "vscode")


class TestConfigValidation:
    """Tests for configuration validation."""

    def test_zero_timeout_rejected(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            IdeBridgeConfig(request_timeout_seconds=0)

    def test_negative_timeout_rejected(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            IdeBridgeConfig(request_timeout_seconds=-1)

    def test_empty_prefer_adapter_rejected(self) -> None:
        with pytest.raises(ValueError, match="prefer_adapter"):
            IdeBridgeConfig(prefer_adapter=())

    def test_empty_string_in_prefer_adapter_rejected(self) -> None:
        with pytest.raises(ValueError, match="prefer_adapter entries"):
            IdeBridgeConfig(prefer_adapter=("", "vscode"))

    def test_whitespace_string_in_prefer_adapter_rejected(self) -> None:
        with pytest.raises(ValueError, match="prefer_adapter entries"):
            IdeBridgeConfig(prefer_adapter=("  ",))

    def test_positive_timeout_accepted(self) -> None:
        config = IdeBridgeConfig(request_timeout_seconds=60)
        assert config.request_timeout_seconds == 60


class TestCustomConfig:
    """Tests for custom configurations."""

    def test_explicit_discovery_file(self) -> None:
        config = IdeBridgeConfig(discovery_file="/tmp/ide-bridge/discovery.json")
        assert config.discovery_file == "/tmp/ide-bridge/discovery.json"

    def test_explicit_workspace(self) -> None:
        config = IdeBridgeConfig(workspace="ws-abc-123")
        assert config.workspace == "ws-abc-123"

    def test_custom_prefer_adapter(self) -> None:
        config = IdeBridgeConfig(prefer_adapter=("vscode",))
        assert config.prefer_adapter == ("vscode",)

    def test_config_equality(self) -> None:
        """Equal configs are equal."""
        a = IdeBridgeConfig()
        b = IdeBridgeConfig()
        assert a == b

    def test_config_inequality(self) -> None:
        """Different configs are not equal."""
        a = IdeBridgeConfig()
        b = IdeBridgeConfig(request_timeout_seconds=60)
        assert a != b
