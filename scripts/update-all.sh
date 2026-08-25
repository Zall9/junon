#!/usr/bin/env bash
# Bring every half of this installation to the current release, and prove each one moved.
#
# There are three halves and they update in three different ways, which is why doing it by hand goes
# wrong: the dashboard's Install button copies the plugin into each IDE and touches nothing else; the
# daemon runs a build from this checkout and keeps the code it started with until it is restarted; and
# JUNON is imported by each agent host at start-up, so it changes when the host does.
#
#   scripts/update-all.sh --dry-run     # say what would happen
#   scripts/update-all.sh               # do it
#   scripts/update-all.sh --no-pull     # build and deploy what is already checked out
#
# Every step is verified after it runs, by reading the version back from the thing that changed rather
# than from what was asked for. The last section lists what only you can do — no script can restart
# the editor you are typing in.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
PULL=1
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --no-pull) PULL=0 ;;
    *) echo "unknown option: $argument"; exit 2 ;;
  esac
done

step() { printf '\n=== %s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
note() { printf '       %s\n' "$*"; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then printf '  would run: %s\n' "$*"; else eval "$@"; fi }

FAILURES=0
WANTED_BEFORE="$(cat VERSION)"

step "0. the working tree"
if [[ -n "$(git status --porcelain)" ]]; then
  # A pull onto local edits is how an update turns into an afternoon of conflict resolution, and this
  # script exists to be run without thinking.
  bad "the checkout has uncommitted changes — commit or stash them first"
  git status --short | head -10 | sed 's/^/       /'
  [[ $DRY_RUN -eq 1 ]] || exit 1
else
  ok "clean"
fi

step "1. the source"
if [[ $PULL -eq 1 ]]; then
  run "LC_ALL=C git pull --ff-only" || bad "git pull failed — resolve it by hand"
else
  note "skipped (--no-pull)"
fi
WANTED="$(cat VERSION)"
ok "this checkout is $WANTED${WANTED_BEFORE:+, was $WANTED_BEFORE}"

step "2. build"
run "pnpm -r build > /tmp/update-all-build.log 2>&1" || bad "pnpm build failed — see /tmp/update-all-build.log"
[[ $DRY_RUN -eq 1 ]] || ok "typescript built"
if [[ -d jetbrains-plugin ]]; then
  run "(cd jetbrains-plugin && ./gradlew buildPlugin -q > /tmp/update-all-gradle.log 2>&1)" \
    || bad "gradle buildPlugin failed — see /tmp/update-all-gradle.log"
  [[ $DRY_RUN -eq 1 ]] || ok "plugin built"
fi

step "3. the daemon — rebuilt code is not running code"
if [[ $DRY_RUN -eq 1 ]]; then
  note "would stop the running daemon and start the new build"
else
  BEFORE_PID="$(pgrep -f 'node packages/cli/dist/bin.js daemon' | head -1 || true)"
  if [[ -n "$BEFORE_PID" ]]; then
    kill "$BEFORE_PID" 2>/dev/null
    for _ in $(seq 1 15); do kill -0 "$BEFORE_PID" 2>/dev/null || break; sleep 1; done
    note "stopped pid $BEFORE_PID"
  else
    note "none was running"
  fi
  nohup node packages/cli/dist/bin.js daemon > /tmp/ide-bridge-daemon.log 2>&1 &
  for _ in $(seq 1 20); do sleep 1; node packages/cli/dist/bin.js status >/dev/null 2>&1 && break; done
  # Read the version back from the process rather than trusting that a restart happened: this is the
  # exact mistake the check in `doctor` was written for.
  RUNNING="$(node packages/cli/dist/bin.js doctor 2>/dev/null \
    | python3 -c 'import json,sys;r=json.load(sys.stdin);print(next((c["detail"] for c in r["checks"] if c["name"]=="versions"), "?"))' 2>/dev/null)"
  NEW_PID="$(pgrep -f 'node packages/cli/dist/bin.js daemon' | head -1 || true)"
  if [[ -n "$NEW_PID" && "$NEW_PID" != "$BEFORE_PID" ]]; then
    ok "daemon restarted as pid $NEW_PID"
    note "$RUNNING"
  else
    bad "the daemon did not restart — see /tmp/ide-bridge-daemon.log"
  fi
fi

step "4. the plugins — one copy per IDE, and a running IDE cannot be written to"
if [[ $DRY_RUN -eq 1 ]]; then
  note "would install the built plugin into every IDE that is closed"
else
  # The marker on the last line is how the findings reach the shell: without it, a failure printed
  # here was invisible to the exit status, and the summary below contradicted its own output.
  PLUGIN_REPORT=$(python3 - <<'PY'
import sys
sys.path.insert(0, "integrations/serena")
try:
    from junon.update_action import install
except Exception as error:  # noqa: BLE001 - report rather than crash the script
    print(f"  FAIL could not import the installer: {error}")
    print("JUNON_FAILURES=1")
    raise SystemExit(0)

outcome = install()
for name in outcome.installed:
    print(f"  ok   {name}: installed")
for name in outcome.unchanged:
    print(f"  ok   {name}: already current")
for name in outcome.running:
    print(f"       {name}: skipped, it is running — quit it and run this again")

# `failed` carries the running IDEs as well as genuine failures; `ok` excludes them and the tuple
# does not. Printing it raw reported each running IDE twice, once correctly and once as a failure.
genuine = [name for name in outcome.failed if name not in outcome.running]
for name in genuine:
    print(f"  FAIL {name}: could not be written to")
if genuine:
    print(f"       {outcome.next_step}")
print(f"JUNON_FAILURES={len(genuine)}")
PY
)
  # `printf`, not `print`: this file is bash, `print` is a zsh builtin, and the whole plugin report
  # silently disappeared behind "print: command not found" the first time this ran.
  printf '%s\n' "${PLUGIN_REPORT%JUNON_FAILURES=*}"
  PLUGIN_FAILURES="${PLUGIN_REPORT##*JUNON_FAILURES=}"
  [[ "${PLUGIN_FAILURES:-0}" =~ ^[0-9]+$ ]] && FAILURES=$((FAILURES + PLUGIN_FAILURES))
fi

step "5. what no script can do for you"
note "JUNON is imported by each agent host at start-up: restart opencode and Claude Code for the"
note "sessions to pick up $WANTED. Any IDE listed as skipped above needs to be closed and reopened."
note "Check with: node packages/cli/dist/bin.js doctor --check-updates"

if [[ $FAILURES -gt 0 ]]; then
  printf '\n%s\n' "  $FAILURES step(s) failed."
  exit 1
fi
printf '\n%s\n' "  Every step that could be automated was done and verified."
