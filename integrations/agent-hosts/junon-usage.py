#!/usr/bin/env python3
"""How much your agents actually use JUNON/Serena, per host and per agent.

Run it before and after changing anything. The reason this script exists is that two rounds of prompt
edits were made on the strength of an impression, and the measurement afterwards showed one agent had
gone from 10.8% symbolic calls to zero — the opposite of the intent, invisible without counting.

    python3 ~/.config/opencode/scripts/junon-usage.py            # last 14 days
    python3 ~/.config/opencode/scripts/junon-usage.py --days 2   # since a change

Reads two histories, both local: opencode's SQLite database and Claude Code's JSONL transcripts.
Nothing is sent anywhere.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sqlite3
import time

FILE_TOOLS = {
    "read", "grep", "glob", "list", "edit", "write", "patch", "multiedit",
    "Read", "Grep", "Glob", "LS", "Edit", "Write", "NotebookEdit",
}


def symbolic(name: str) -> bool:
    """A call answered by an index or an IDE rather than by re-reading the disk."""
    return name.startswith("serena_") or "ide_" in name or "mcp__serena__" in name


def summarise(label: str, counter: collections.Counter) -> None:
    total = sum(counter.values())
    if not total:
        print(f"  {label:24} —")
        return
    junon = sum(count for name, count in counter.items() if symbolic(name))
    files = sum(count for name, count in counter.items() if name in FILE_TOOLS)
    print(
        f"  {label:24} {total:6} calls   junon {junon:5} ({junon / total:5.1%})"
        f"   file {files:5} ({files / total:5.1%})"
    )


def opencode(since_ms: float) -> None:
    path = os.path.expanduser("~/.local/share/opencode/opencode.db")
    if not os.path.exists(path):
        print("\nopencode: no database")
        return
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    agent_of: dict[str, str] = {}
    for message_id, data in connection.execute(
        "select id, data from message where time_created > ?", (since_ms,)
    ):
        try:
            parsed = json.loads(data)
        except ValueError:
            continue
        if parsed.get("role") == "assistant":
            agent_of[message_id] = parsed.get("agent") or parsed.get("mode") or "?"

    per_agent: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for message_id, data in connection.execute(
        "select message_id, data from part where time_created > ?", (since_ms,)
    ):
        try:
            parsed = json.loads(data)
        except ValueError:
            continue
        if parsed.get("type") != "tool":
            continue
        per_agent[agent_of.get(message_id, "?")][parsed.get("tool") or "?"] += 1

    print("\nopencode, per agent:")
    for agent, counter in sorted(per_agent.items(), key=lambda item: -sum(item[1].values()))[:12]:
        summarise(agent, counter)


def claude_code(since: float) -> None:
    counter: collections.Counter = collections.Counter()
    for path in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        try:
            if os.path.getmtime(path) < since:
                continue
            with open(path, encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if '"tool_use"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    content = (event.get("message") or {}).get("content")
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            counter[block.get("name", "?")] += 1
        except OSError:
            continue
    print("\nClaude Code:")
    summarise("all sessions", counter)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=float, default=14)
    days = parser.parse_args().days
    since = time.time() - days * 86_400
    print(f"Tool use over the last {days:g} days")
    claude_code(since)
    opencode(since * 1000)


if __name__ == "__main__":
    main()
