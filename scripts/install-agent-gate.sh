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
# This file is only the command. The work is `integrations/serena/junon/agent_gates.py`, which the
# dashboard's install button and every starting JUNON instance also use, and what goes where is
# `integrations/agent-hosts/manifest.json`, which `ide-bridge doctor` reads too. Three routes, one
# implementation: the first version of this was a second installer, and two routes drift.
#
# A copy that differs is kept under ~/.ide-bridge/agent-gate-backups — outside every directory a host
# scans for plugins — before it is replaced. Nothing here edits an agent's permissions or settings:
# the Claude Code hook needs one line registered in settings.json, and that line is yours to run.
#
#   scripts/install-agent-gate.sh --dry-run     # say what would happen
#   scripts/install-agent-gate.sh               # install, or update what differs
#   scripts/install-agent-gate.sh --check       # exit 1 if an installed copy differs from this JUNON

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/integrations/serena/junon/agent_gates.py" "$@"
