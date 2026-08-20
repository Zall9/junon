#!/usr/bin/env bash
# Installs the file-tool gate into the agent hosts on this machine.
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
# Nothing here edits an agent's permissions or settings. The opencode plugin is a file in a directory
# that is already scanned; the Claude Code hook needs one line registered in settings.json, and that
# line is yours to run — a tool that can install its own hooks can install anything.
#
#   scripts/install-agent-gate.sh --dry-run     # say what would happen
#   scripts/install-agent-gate.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/integrations/agent-hosts"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

say() { printf '  %s\n' "$*"; }

install_file() {
  local from="$1" to="$2" mode="${3:-644}"
  if [[ $DRY_RUN -eq 1 ]]; then
    say "would install $to"
    return
  fi
  mkdir -p "$(dirname "$to")"
  cp "$from" "$to"
  chmod "$mode" "$to"
  say "installed $to"
}

echo "opencode"
if [[ -d "$HOME/.config/opencode" ]]; then
  # Both `plugin/` and `plugins/` are scanned — verified by loading a probe from each and watching
  # which marker appeared. `plugin/` is the documented one.
  install_file "$SOURCE/opencode/junon-first.ts" "$HOME/.config/opencode/plugin/junon-first.ts"
  say "takes effect on the next opencode start"
else
  say "not configured on this machine — skipped"
fi

echo "Claude Code"
if [[ -d "$HOME/.claude" ]]; then
  install_file "$SOURCE/claude-code/junon-first-gate" "$HOME/.claude/hooks/junon-first-gate" 755
  install_file "$SOURCE/claude-code/register-junon-gate.py" "$HOME/.claude/hooks/register-junon-gate.py"
  say "one line left, and it is yours to run:"
  say "    python3 ~/.claude/hooks/register-junon-gate.py"
  say "then restart Claude Code — hooks are read at start-up"
else
  say "not configured on this machine — skipped"
fi

echo "measurement"
install_file "$SOURCE/junon-usage.py" "$HOME/.config/opencode/scripts/junon-usage.py" 755 2>/dev/null || \
  say "no ~/.config/opencode/scripts — run it from $SOURCE/junon-usage.py"
say "python3 $SOURCE/junon-usage.py --days 2"
say "run it before and after, or you are back to impressions"
