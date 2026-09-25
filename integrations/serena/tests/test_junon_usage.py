"""`junon-usage.py` reads both opencodes' histories — built here as each actually stores them.

The shapes are the measured ones: opencode 1 writes `message` and `part` rows and names an MCP call
after its tool; opencode 2 writes `session_message` rows whose `content` holds the tool parts, and
reaches MCP tools only through `execute`. Until 0.3.10 the script read only opencode 1's tables, so a
machine running opencode 2 got a report about sessions nobody was running any more.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "agent-hosts" / "junon-usage.py"
NOW = int(time.time() * 1000)


def build(path: Path) -> None:
    db = sqlite3.connect(path)
    db.execute("create table message (id text, session_id text, time_created int, time_updated int, data text)")
    db.execute("create table part (id text, message_id text, session_id text, time_created int, time_updated int, data text)")
    db.execute("create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text)")

    # opencode 1: one serena call by name, two file reads, one of them refused by the gate.
    db.execute("insert into message values ('m1', 's1', ?, ?, ?)", (NOW, NOW, json.dumps({"role": "assistant", "agent": "explorer"})))
    for n, (tool, state) in enumerate([
        ("serena_find_symbol", {"status": "completed", "input": {"name_path_pattern": "x"}}),
        ("read", {"status": "completed", "input": {"filePath": "/a.ts"}}),
        ("read", {"status": "error", "input": {"filePath": "/b.ts"}, "error": "read of /b.ts was not run — ..."}),
    ]):
        db.execute("insert into part values (?, 'm1', 's1', ?, ?, ?)", (f"p{n}", NOW, NOW, json.dumps({"type": "tool", "tool": tool, "state": state})))

    # opencode 2: serena through execute, an execute that is not serena, a grep refused by the gate.
    content = [
        {"type": "tool", "name": "execute", "state": {"status": "completed", "input": {"code": 'return await tools.serena.find_symbol({ name_path_pattern: "x" })'}}},
        {"type": "tool", "name": "execute", "state": {"status": "completed", "input": {"code": 'return await tools["basic-memory-remote"].search_notes({})'}}},
        {"type": "tool", "name": "grep", "state": {"status": "error", "input": {"pattern": "compose"}, "error": {"type": "unknown", "message": 'grep "compose" was not run. Ask the index instead'}}},
        # The gate answered a whole read with an outline: recorded as the `read` the model made.
        {"type": "tool", "name": "read", "state": {"status": "completed", "input": {"path": "/c.ts"}, "content": [{"type": "text", "text": "read of /c.ts (812 lines) answered with its outline by JUNON, not with its text"}]}},
        # ...and one it could not outline: the refusal came back as the read's result, not an error.
        {"type": "tool", "name": "read", "state": {"status": "completed", "input": {"path": "/d.ts"}, "content": [{"type": "text", "text": "read of /d.ts (500 lines) was not run ...\n(No outline: serena is not in this turn's tool catalog)"}]}},
        # A grep answered from the index.
        {"type": "tool", "name": "grep", "state": {"status": "completed", "input": {"pattern": "startWorkflow"}, "content": [{"type": "text", "text": 'grep "startWorkflow" answered from the index by JUNON, not run\nFrom the IDE\'s index'}]}},
        # An edit the gate had the IDE check, and one it did not.
        {"type": "tool", "name": "edit", "state": {"status": "completed", "input": {"path": "/e.ts"}, "content": [{"type": "text", "text": "Edited e.ts"}, {"type": "text", "text": "\n\nJUNON: the IDE finds 1 error(s) in this file after the edit:\n  line 3: x"}]}},
        {"type": "tool", "name": "edit", "state": {"status": "completed", "input": {"path": "/f.ts"}, "content": [{"type": "text", "text": "Edited f.ts"}]}},
        # A read of a file that merely contains the sentences — the gate's own source — is a read.
        {"type": "tool", "name": "read", "state": {"status": "completed", "input": {"path": "/gate.ts"}, "content": [{"type": "text", "text": 'import { readFileSync } from "node:fs"\nconst OUTLINED = "answered with its outline by JUNON"\n(No outline: '}]}},
        {"type": "text", "text": "done"},
    ]
    db.execute("insert into session_message values ('sm1', 's2', 'assistant', 1, ?, ?, ?)", (NOW, NOW, json.dumps({"agent": "orchestrator", "content": content})))
    db.commit()
    db.close()


def report(db: Path) -> str:
    out = subprocess.run([sys.executable, str(SCRIPT), "--db", str(db), "--days", "1", "--no-claude-code"],
                         capture_output=True, text=True, check=True)
    return out.stdout


def count(line: str, label: str) -> int:
    """The number beside a label, whatever the column alignment: `3 calls`, `junon 1`, ..."""
    import re

    before = re.search(rf"(\d+)\s+{label}\b", line)
    after = re.search(rf"\b{label}\s+(\d+)", line)
    return int((before if label == "calls" else after).group(1))


def line_for(text: str, section: str, agent: str) -> str:
    in_section = False
    for line in text.splitlines():
        if line.startswith(section):
            in_section = True
        elif line and not line.startswith(" "):
            in_section = False
        elif in_section and line.strip().startswith(agent):
            return line
    raise AssertionError(f"no line for {agent} under {section}:\n{text}")


class TestBothOpencodes:
    def test_opencode_2_sessions_are_read_and_serena_through_execute_counts(self, tmp_path: Path) -> None:
        db = tmp_path / "opencode.db"
        build(db)

        line = line_for(report(db), "opencode 2", "orchestrator")

        assert count(line, "calls") == 9
        assert count(line, "junon") == 1, line    # the execute that calls tools.serena
        assert count(line, "refused") == 2, line  # the grep, and the read no outline could answer
        assert count(line, "answered") == 2, line  # the outline and the grep answered from the index
        assert count(line, "file") == 5, line     # an answer is not a file entering the context; the reads and edits are
        assert count(line, "checked") == 1, line  # the edit the IDE checked, not the other

    def test_opencode_1_sessions_are_still_read_as_before(self, tmp_path: Path) -> None:
        db = tmp_path / "opencode.db"
        build(db)

        line = line_for(report(db), "opencode 1", "explorer")

        assert count(line, "calls") == 3
        assert count(line, "junon") == 1, line
        assert count(line, "file") == 2, line
        assert count(line, "refused") == 1, line

    def test_a_database_that_has_only_one_schema_is_not_an_error(self, tmp_path: Path) -> None:
        db = tmp_path / "old.db"
        connection = sqlite3.connect(db)
        connection.execute("create table message (id text, time_created int, data text)")
        connection.execute("create table part (message_id text, time_created int, data text)")
        connection.close()

        text = report(db)

        assert "opencode 2, per agent:\n  no sessions in this period" in text
