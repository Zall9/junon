"""Discovery reading, including the cases that are security decisions rather than parsing.

The discovery file carries an authentication token for a daemon that can edit the user's source
tree. Every reader of it — TypeScript, Kotlin, and this one — refuses a file that other users can
read, and that guard only works if it is genuinely in every reader. These tests are this reader's
share of that.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from junon.client import (
    DaemonUnavailableError,
    DiscoveryUntrustedError,
    read_discovery,
)


def _write_discovery(directory: Path, **overrides: object) -> Path:
    payload = {
        "endpoint": "ws://127.0.0.1:47821",
        "token": "a" * 64,
        "protocolVersion": "0.1.0",
    }
    payload.update(overrides)
    path = directory / "discovery.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return path


class TestReadingASoundFile:
    def test_it_reads_the_endpoint_and_version(self, tmp_path: Path) -> None:
        discovery = read_discovery(_write_discovery(tmp_path))

        assert discovery.endpoint == "ws://127.0.0.1:47821"
        assert discovery.protocol_version == "0.1.0"

    def test_the_redacted_view_carries_no_token(self, tmp_path: Path) -> None:
        """This is what reaches the dashboard, and a dashboard response is the last place a local
        credential should end up — it would be one XSS away from leaving the machine."""
        discovery = read_discovery(_write_discovery(tmp_path))

        assert "token" not in discovery.redacted()
        assert discovery.token not in json.dumps(discovery.redacted())


class TestRefusals:
    def test_a_missing_file_names_where_it_looked(self, tmp_path: Path) -> None:
        """"No daemon" is the most common state of this system, so the message has to be useful
        rather than merely correct."""
        with pytest.raises(DaemonUnavailableError) as caught:
            read_discovery(tmp_path / "absent.json")

        assert str(tmp_path) in str(caught.value)
        assert "IDE_BRIDGE_DISCOVERY_FILE" in str(caught.value)

    @pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
    def test_a_group_readable_file_is_refused_not_treated_as_absent(self, tmp_path: Path) -> None:
        """The distinction that matters.

        Reporting a widened-permission token file as "no daemon" would hide a security signal
        behind the most ordinary state in the system — the one everybody learns to ignore.
        """
        path = _write_discovery(tmp_path)
        path.chmod(0o640)

        with pytest.raises(DiscoveryUntrustedError):
            read_discovery(path)

    @pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
    def test_a_world_readable_file_is_refused(self, tmp_path: Path) -> None:
        path = _write_discovery(tmp_path)
        path.chmod(0o604)

        with pytest.raises(DiscoveryUntrustedError):
            read_discovery(path)

    def test_a_truncated_file_says_what_is_missing(self, tmp_path: Path) -> None:
        """A daemon from an older version writes fewer fields; the message should point there
        rather than leaving the reader to guess at a parse error."""
        path = tmp_path / "discovery.json"
        path.write_text(json.dumps({"endpoint": "ws://127.0.0.1:1"}), encoding="utf-8")
        path.chmod(0o600)

        with pytest.raises(DaemonUnavailableError) as caught:
            read_discovery(path)

        assert "token" in str(caught.value)
        assert "protocolVersion" in str(caught.value)

    def test_malformed_json_is_not_a_crash(self, tmp_path: Path) -> None:
        path = tmp_path / "discovery.json"
        path.write_text("{not json", encoding="utf-8")
        path.chmod(0o600)

        with pytest.raises(DaemonUnavailableError):
            read_discovery(path)


class TestPermissionGuardIsRealNotIncidental:
    @pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
    def test_a_private_file_passes_the_same_check(self, tmp_path: Path) -> None:
        """Pins that the refusals above come from the permission bits rather than from anything
        else about those files — without this, the guard could be inverted and still look tested."""
        path = _write_discovery(tmp_path)
        assert not path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO)

        read_discovery(path)
