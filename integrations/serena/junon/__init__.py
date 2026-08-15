"""JUNON — IDE Bridge integration for Serena, applied without editing Serena.

Everything here works by runtime composition: Serena is imported unmodified and a handful of named
attributes are rebound to our subclasses. See :mod:`junon.compose` for the seams and the order they
must be applied in, and ``tests/test_upstream_seams.py`` for the contract that makes an upstream
update fail loudly instead of mysteriously.
"""

from junon.compose import Composition, compose

__all__ = ["Composition", "compose"]
