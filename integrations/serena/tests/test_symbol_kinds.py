"""The Python vocabulary against the schema that defines it.

`SYMBOL_KINDS` is transcribed, not generated — Python has no mirror of the protocol schemas the way
Kotlin and TypeScript do. A transcription is a copy, and a copy drifts silently: a kind added to the
protocol would leave this list quietly short, and a tool filtering on kinds would refuse a word the
daemon accepts.

So the schema is read as the source of truth and compared by content. If these files ever move apart
in the tree, this fails loudly rather than skipping.
"""

from __future__ import annotations

import json
from pathlib import Path

from ide_bridge.models import SYMBOL_KINDS, UNCLASSIFIED

SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "protocol"
    / "schemas"
    / "common"
    / "symbol.schema.json"
)


def schema_kinds() -> list[str]:
    assert SCHEMA.is_file(), (
        f"the protocol schema was not found at {SCHEMA}; this guard is not guarding"
    )
    return json.loads(SCHEMA.read_text())["$defs"]["symbolKind"]["enum"]


def test_the_vocabulary_matches_the_schema_exactly() -> None:
    """Order included: the schema's order is the protocol's, and a reordering is worth noticing."""
    assert list(SYMBOL_KINDS) == schema_kinds()


def test_unclassified_is_a_member_of_the_vocabulary() -> None:
    """`unknown` must be a kind the daemon accepts in a filter, not a word invented here — the
    search tool asks for it explicitly so unclassified declarations can be reported rather than
    dropped."""
    assert UNCLASSIFIED in schema_kinds()
