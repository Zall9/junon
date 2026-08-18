"""This half's version is the repository's, and it is what goes on the wire.

JUNON used to send `"version": "0.1.0"` written into the handshake frame by hand, from a package
that declared `0.0.0`. Two numbers, both wrong, and neither comparable to the daemon's — which is
why nothing could tell a user that one half of the product was older than the other.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def test_the_package_version_is_the_repository_version() -> None:
    declared = tomllib.loads(PYPROJECT.read_text())["project"]["version"]

    assert declared == (REPO / "VERSION").read_text().strip()


def test_the_handshake_sends_the_distribution_version_not_a_literal() -> None:
    """A literal here is a seventh copy of the number, and the one nobody would remember."""
    from junon.client import JUNON_VERSION, IdeBridgeClient  # noqa: F401

    source = (Path(__file__).resolve().parent.parent / "junon/client.py").read_text()
    frame = re.search(r'"clientInfo":\s*\{[^}]*\}', source)

    assert frame is not None
    assert "JUNON_VERSION" in frame.group(0)
    assert not re.search(r'"version":\s*"\d+\.\d+\.\d+"', frame.group(0))


def test_an_uninstalled_checkout_still_reports_something_speakable() -> None:
    """A handshake is the wrong place to discover a packaging problem: it must not raise."""
    from junon.client import _junon_version

    assert re.match(r"^\d+\.\d+\.\d+", _junon_version())
