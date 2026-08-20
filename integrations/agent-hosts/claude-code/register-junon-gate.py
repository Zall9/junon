#!/usr/bin/env python3
"""Registers `junon-first-gate` in ~/.claude/settings.json. Run it yourself — I am not allowed to.

Claude Code refuses to let an agent edit its own hook configuration, which is the right rule: a tool
that can install its own hooks can install anything. So the gate is written, executable and tested,
and this last line is yours to run:

    python3 ~/.claude/hooks/register-junon-gate.py

It keeps a backup, it is idempotent, and it leaves `cbm-code-discovery-gate` in place — that hook is
yours and aimed at a different index. Hooks are read when Claude Code starts, so restart it after.

To undo: delete the `junon-first-gate` entry from settings.json, or restore the backup this writes.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

SETTINGS = Path.home() / ".claude/settings.json"
COMMAND = "~/.claude/hooks/junon-first-gate"
MATCHER = "Grep|Glob|Read|Search"


def main() -> None:
    config = json.loads(SETTINGS.read_text())
    entries = config.setdefault("hooks", {}).setdefault("PreToolUse", [])

    entry = next((e for e in entries if e.get("matcher") == MATCHER), None)
    if entry is None:
        entry = {"matcher": MATCHER, "hooks": []}
        entries.append(entry)

    if any(hook.get("command") == COMMAND for hook in entry.get("hooks", [])):
        print("Already registered — nothing to do.")
        return

    backup = SETTINGS.with_suffix(".json.backup-junon-gate")
    shutil.copy(SETTINGS, backup)
    entry.setdefault("hooks", []).append({"type": "command", "command": COMMAND})
    SETTINGS.write_text(json.dumps(config, indent=2) + "\n")
    print(f"Registered. Backup at {backup}. Restart Claude Code for it to take effect.")


if __name__ == "__main__":
    main()
