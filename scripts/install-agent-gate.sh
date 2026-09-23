#!/usr/bin/env bash
# Installs the file-tool gate into the agent hosts on this machine — and keeps it current.
#
# Installing the IDE Bridge tools is not the same as an agent using them, and the gap is not a matter
# of persuasion. Measured from opencode's own database, in the two days after the subagent prompts
# were rewritten to insist on the symbolic tools:
#
#   explorer      319 calls   junon   0 (0.0%)   file 272 (85.3%)
#   fixer         318 calls   junon  34 (10.7%)  file 230 (72.3%)
#   orchestrator  756 calls   junon  15 (2.0%)   file 187 (24.7%)
#
# explorer had been at 10.8% over the preceding fortnight. Being told twice, in two files, took it to
# zero. So this installs an interception instead: one refusal per target, naming the call that
# answers better, and the same call repeated runs.
#
# **It runs on every update**, from `scripts/update-all.sh` and from the dashboard's install button.
# Until 0.3.10 nothing called it after the first install, so the gate on a machine was whatever had
# been copied there once: when that machine moved to opencode 2, the copy was ported by hand, lived
# only there, and advised tools opencode 2 does not have. A copy that differs from this repository is
# kept — under ~/.ide-bridge/agent-gate-backups, outside every directory a host scans for plugins —
# before it is replaced.
#
# Nothing here edits an agent's permissions or settings. The opencode plugin is a file in a directory
# that is already scanned; the Claude Code hook needs one line registered in settings.json, and that
# line is yours to run — a tool that can install its own hooks can install anything.
#
#   scripts/install-agent-gate.sh --dry-run     # say what would happen
#   scripts/install-agent-gate.sh               # install, or update what differs
#   scripts/install-agent-gate.sh --check       # exit 1 if an installed copy differs from this repo

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/integrations/agent-hosts"
MODE=install
case "${1:-}" in
  --dry-run) MODE=dry-run ;;
  --check) MODE=check ;;
  "") ;;
  *) echo "unknown option: $1"; exit 2 ;;
esac

BACKUPS="$HOME/.ide-bridge/agent-gate-backups/$(date +%Y%m%d-%H%M%S)"
DIFFERS=0

say() { printf '  %s\n' "$*"; }

# install_file <source> <target> [mode]
install_file() {
  local from="$1" to="$2" mode="${3:-644}"
  if [[ -f "$to" ]] && cmp -s "$from" "$to"; then
    say "current   $to"
    return
  fi
  if [[ $MODE == check ]]; then
    if [[ -f "$to" ]]; then say "DIFFERS   $to"; else say "MISSING   $to"; fi
    DIFFERS=1
    return
  fi
  if [[ $MODE == dry-run ]]; then
    if [[ -f "$to" ]]; then say "would update $to (the current copy would be kept)"; else say "would install $to"; fi
    return
  fi
  mkdir -p "$(dirname "$to")"
  if [[ -f "$to" ]]; then
    mkdir -p "$BACKUPS"
    cp -p "$to" "$BACKUPS/$(basename "$to")"
    say "kept      $BACKUPS/$(basename "$to")  (it differed from this repository)"
  fi
  cp "$from" "$to"
  chmod "$mode" "$to"
  say "installed $to"
}

echo "opencode"
if [[ -d "$HOME/.config/opencode" ]]; then
  # Both `plugin/` and `plugins/` are scanned — verified by loading a probe from each and watching
  # which marker appeared. `plugin/` is the documented one. One file serves opencode 1 and 2.
  install_file "$SOURCE/opencode/junon-first.ts" "$HOME/.config/opencode/plugin/junon-first.ts"
  if [[ -f "$HOME/.config/opencode/plugins/junon-first.ts" ]]; then
    # A second copy would be loaded as a second plugin, and every call judged twice.
    say "WARNING   a second copy is loaded from $HOME/.config/opencode/plugins/junon-first.ts — remove it"
    DIFFERS=1
  fi
  [[ $MODE == install ]] && say "takes effect on the next opencode start"
else
  say "not configured on this machine — skipped"
fi

echo "Claude Code"
if [[ -d "$HOME/.claude" ]]; then
  install_file "$SOURCE/claude-code/junon-first-gate" "$HOME/.claude/hooks/junon-first-gate" 755
  install_file "$SOURCE/claude-code/register-junon-gate.py" "$HOME/.claude/hooks/register-junon-gate.py"
  if ! grep -qs "junon-first-gate" "$HOME/.claude/settings.json"; then
    say "one line left, and it is yours to run:"
    say "    python3 ~/.claude/hooks/register-junon-gate.py"
    say "then restart Claude Code — hooks are read at start-up"
  fi
else
  say "not configured on this machine — skipped"
fi

echo "measurement"
if [[ -d "$HOME/.config/opencode" ]]; then
  install_file "$SOURCE/junon-usage.py" "$HOME/.config/opencode/scripts/junon-usage.py" 755
fi
[[ $MODE == install ]] && say "python3 $SOURCE/junon-usage.py --days 2 — before and after, or you are back to impressions"

if [[ $MODE == check && $DIFFERS -ne 0 ]]; then
  exit 1
fi
exit 0
