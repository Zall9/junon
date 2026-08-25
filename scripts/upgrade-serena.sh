#!/usr/bin/env bash
# Take a Serena release only if the installation still works afterwards — and undo it if not.
#
# JUNON is composed onto an unmodified Serena, installed by pipx with JUNON injected into the same
# venv as an editable package. Serena's releases therefore arrive from a channel that knows nothing
# about JUNON, and that door has broken this machine twice: 1.5.3 changed the signature of
# `run_in_thread` and JUNON's override killed the agent at start-up, and a config schema change made
# 26 of 27 projects unloadable. Neither was visible in a version number.
#
# So: baseline -> upgrade -> prove it still works -> if not, put the old one back and prove that.
#
#   scripts/upgrade-serena.sh --check          # what is installed, what is published
#   scripts/upgrade-serena.sh --dry-run        # what it would do
#   scripts/upgrade-serena.sh                  # do it, with the rollback armed
#   scripts/upgrade-serena.sh --to 1.6.1       # a specific version, including going back
#
# Exit codes: 0 fine, 1 the upgrade did not hold and was rolled back, 2 the rollback did not restore
# a working installation — the one state that needs a human immediately.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/integrations/serena/.venv/bin/python"

# Run from the repository's own venv, not from the pipx venv being replaced: a script cannot rely on
# the interpreter it is rewriting mid-flight.
[[ -x "$PYTHON" ]] || { echo "  no venv at $PYTHON — create it first (see docs/AGENT_SETUP.md §5)"; exit 1; }

cd "$ROOT/integrations/serena"
exec "$PYTHON" -m junon.serena_upgrade "$ROOT" "$@"
