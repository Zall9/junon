#!/usr/bin/env python3
"""How much your agents actually use JUNON/Serena, per host and per agent — and what the gate refused.

Run it before and after changing anything. The reason this script exists is that two rounds of prompt
edits were made on the strength of an impression, and the measurement afterwards showed one agent had
gone from 10.8% symbolic calls to zero — the opposite of the intent, invisible without counting.

    python3 ~/.config/opencode/scripts/junon-usage.py            # last 14 days
    python3 ~/.config/opencode/scripts/junon-usage.py --days 2   # since a change

Reads two histories, both local: opencode's SQLite database and Claude Code's JSONL transcripts.
Nothing is sent anywhere.

**Both opencodes.** opencode 1 keeps its sessions in the `message` and `part` tables, and names an MCP
call after its tool: `serena_find_symbol`. opencode 2 keeps them in `session_message`, and has no MCP
tools at all — a model reaches them through `execute`, as code: `await tools.serena.find_symbol(...)`.
Until 0.3.10 this read only opencode 1's tables and counted by name, so on a machine that had moved to
opencode 2 it reported nothing about the sessions actually being run. Measured, not supposed: see
docs/OPENCODE.md in the IDE Bridge repository.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sqlite3
import time

FILE_TOOLS = {
    "read", "grep", "glob", "list", "edit", "write", "patch", "multiedit",
    "Read", "Grep", "Glob", "LS", "Edit", "Write", "NotebookEdit",
}

#: `tools.serena.x` or `tools["serena"].x` inside an opencode 2 `execute`.
SERENA_IN_CODE = re.compile(r"\btools\s*(?:\.\s*serena\b|\[\s*[\"']serena[\"']\s*\])")

#: What the file-tool gate's refusals say, in every form it has had.
REFUSED = "was not run"

#: How an opencode 2 call the gate answered in its place begins: a `read` answered with the file's
#: outline, a `grep` answered from the index. The database records the call the model made, with its
#: original input, so only the output tells it from a call that ran — and only the output's first
#: line: a `read` of a file that merely contains the sentence, such as the gate's own source, is a read.
ANSWERED = re.compile(r'^(read of .* answered with its outline by JUNON|grep ".*" answered from the index by JUNON)')
#: How one begins when no answer could be made and the refusal came back as its result.
UNANSWERED = re.compile(r'^(read of .*|grep ".*") was not run')
NO_ANSWER = re.compile(r"\((No outline|No answer from the index): ")

#: The keys a counter uses beside tool names.
EXECUTE_SERENA = "execute → tools.serena"
REFUSALS = "(refused by the gate)"
ANSWERS = "(answered by the gate)"


def symbolic(name: str) -> bool:
    """A call answered by an index or an IDE rather than by re-reading the disk."""
    return name == EXECUTE_SERENA or name.startswith("serena_") or "ide_" in name or "mcp__serena__" in name


def summarise(label: str, counter: collections.Counter) -> None:
    refused = counter.pop(REFUSALS, 0)
    total = sum(counter.values())
    if not total:
        print(f"  {label:24} —")
        return
    # An answer is JUNON answering in the agent's place — an outline, an index lookup — so it is
    # neither the agent choosing serena nor a file entering the context: its own column.
    answered = counter.get(ANSWERS, 0)
    junon = sum(count for name, count in counter.items() if symbolic(name))
    files = sum(count for name, count in counter.items() if name in FILE_TOOLS)
    print(
        f"  {label:24} {total:6} calls   junon {junon:5} ({junon / total:5.1%})"
        f"   file {files:5} ({files / total:5.1%})   refused {refused:4}   answered {answered:4}"
    )


def first_line(content: object) -> tuple[str, str]:
    """The first line of a tool part's output, and the whole of its first text."""
    items = content if isinstance(content, list) else [content]
    for item in items:
        text = item.get("text") if isinstance(item, dict) else item if isinstance(item, str) else None
        if isinstance(text, str):
            return text.split("\n", 1)[0], text
    return "", ""


def tool_key(name: str, arguments: object) -> str:
    """The counter key for one call: opencode 2's `execute` is split by whether it calls serena."""
    if name == "execute" and SERENA_IN_CODE.search(json.dumps(arguments)):
        return EXECUTE_SERENA
    return name


def was_refused(state: object) -> bool:
    return REFUSED in json.dumps(state) if state else False


def opencode_1(connection: sqlite3.Connection, since_ms: float) -> dict[str, collections.Counter]:
    """`message` + `part`: one row per message, one per part; a tool part names its `tool`."""
    per_agent: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    try:
        agent_of: dict[str, str] = {}
        for message_id, data in connection.execute("select id, data from message where time_created > ?", (since_ms,)):
            try:
                parsed = json.loads(data)
            except ValueError:
                continue
            if parsed.get("role") == "assistant":
                agent_of[message_id] = parsed.get("agent") or parsed.get("mode") or "?"
        for message_id, data in connection.execute("select message_id, data from part where time_created > ?", (since_ms,)):
            try:
                parsed = json.loads(data)
            except ValueError:
                continue
            if parsed.get("type") != "tool":
                continue
            state = parsed.get("state") or {}
            counter = per_agent[agent_of.get(message_id, "?")]
            counter[tool_key(parsed.get("tool") or "?", state.get("input"))] += 1
            if was_refused(state.get("error") or state.get("output")):
                counter[REFUSALS] += 1
    except sqlite3.OperationalError:
        pass  # a database that never held opencode 1 sessions
    return per_agent


def opencode_2(connection: sqlite3.Connection, since_ms: float) -> dict[str, collections.Counter]:
    """`session_message`: one row per message; its `content` holds the tool parts."""
    per_agent: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    try:
        rows = connection.execute(
            "select data from session_message where type = 'assistant' and time_created > ?", (since_ms,)
        )
        for (data,) in rows:
            try:
                parsed = json.loads(data)
            except ValueError:
                continue
            counter = per_agent[parsed.get("agent") or "?"]
            for part in parsed.get("content") or []:
                if not isinstance(part, dict) or part.get("type") != "tool":
                    continue
                state = part.get("state") or {}
                name = part.get("name") or "?"
                head, text = first_line(state.get("content")) if name in ("read", "grep") else ("", "")
                if ANSWERED.match(head):
                    counter[ANSWERS] += 1
                    continue
                counter[tool_key(name, state.get("input"))] += 1
                if was_refused(state.get("error")) or (UNANSWERED.match(head) and NO_ANSWER.search(text)):
                    counter[REFUSALS] += 1
    except sqlite3.OperationalError:
        pass  # a database from before opencode 2
    return per_agent


def opencode(since_ms: float, path: str) -> None:
    if not os.path.exists(path):
        print("\nopencode: no database")
        return
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for label, per_agent in (("opencode 2", opencode_2(connection, since_ms)), ("opencode 1", opencode_1(connection, since_ms))):
        print(f"\n{label}, per agent:")
        if not per_agent:
            print("  no sessions in this period")
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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=float, default=14)
    parser.add_argument("--db", default=os.path.expanduser("~/.local/share/opencode/opencode.db"),
                        help="opencode's database (default: the one opencode 1 and 2 both use)")
    parser.add_argument("--no-claude-code", action="store_true", help="skip Claude Code's transcripts")
    options = parser.parse_args()
    since = time.time() - options.days * 86_400
    print(f"Tool use over the last {options.days:g} days")
    if not options.no_claude_code:
        claude_code(since)
    opencode(since * 1000, options.db)


if __name__ == "__main__":
    main()
