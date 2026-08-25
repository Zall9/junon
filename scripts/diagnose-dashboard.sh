#!/usr/bin/env bash
# "I followed AGENT_SETUP and I get Serena's dashboard, not JUNON's."
#
# Run this on the machine that has the problem and read the verdict at the end. It changes nothing —
# every line is a question — and it prints the evidence for each answer rather than an opinion, so the
# output can be pasted into a message and read by someone else.
#
#   scripts/diagnose-dashboard.sh
#
# Three causes account for nearly all of it, and only the first is visible in a config file:
#
#   1. the agent host launches `serena` instead of `junon`;
#   2. the host was never restarted after that was fixed, so the process it started still holds the
#      old command — a config file that reads correctly and a process that is wrong look identical
#      until you ask the process;
#   3. it *is* JUNON, and the tools are named `serena_*` because the MCP server is named "serena".
#      `serena_ide_read_symbol` is a JUNON tool wearing the server's name.

set -uo pipefail

say() { printf '%s\n' "$*"; }
head2() { printf '\n=== %s\n' "$*"; }

verdicts=()

head2 "1. Dashboards listening on this machine"
found_any=0
for port in $(seq 24282 24292); do
  code=$(curl -s -m 2 -o /tmp/junon-diag.html -w '%{http_code}' "http://127.0.0.1:${port}/dashboard/index.html" 2>/dev/null)
  [[ "$code" == "200" ]] || continue
  found_any=1
  title=$(grep -oE '<title>[^<]*' /tmp/junon-diag.html 2>/dev/null | sed 's/<title>//')
  junon=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/junon/ide-bridge/status" 2>/dev/null)
  pid=$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1)
  command=$(ps -o command= -p "${pid:-0}" 2>/dev/null | tr -s ' ' | cut -c1-110)
  # The route is the test, not the title: a page can be cached, a route cannot be faked.
  if [[ "$junon" == "200" ]]; then
    say "  :${port}  JUNON        (title '${title}', /junon/ide-bridge/status → 200)"
  else
    say "  :${port}  PLAIN SERENA (title '${title}', /junon/ide-bridge/status → ${junon})"
    verdicts+=("port ${port} is served by a plain Serena — see step 2 for which process that is")
  fi
  say "         pid ${pid:-?}: ${command}"
  started=$(ps -o lstart= -p "${pid:-0}" 2>/dev/null | tr -s ' ')
  [[ -n "$started" ]] && say "         started ${started}"
done
[[ $found_any -eq 1 ]] || say "  none — no agent with a dashboard is running"

head2 "2. Which binary each MCP server actually runs"
mapfile -t servers < <(pgrep -fl "bin/(junon|serena) start-mcp-server" 2>/dev/null || true)
if [[ ${#servers[@]} -eq 0 ]]; then
  say "  no MCP server running"
else
  for line in "${servers[@]}"; do
    pid=${line%% *}
    binary=$(ps -o command= -p "$pid" | grep -oE 'bin/(junon|serena)' | head -1)
    parent=$(ps -o ppid= -p "$pid" | tr -d ' ')
    parent_command=$(ps -o command= -p "${parent:-0}" 2>/dev/null | tr -s ' ' | cut -c1-70)
    started=$(ps -o lstart= -p "$pid" | tr -s ' ')
    say "  pid ${pid}  ${binary}   started ${started}"
    say "         launched by: ${parent_command}"
    if [[ "$binary" == "bin/serena" ]]; then
      verdicts+=("pid ${pid} is plain Serena, launched by: ${parent_command} — that host is the problem")
    fi
  done
fi

head2 "3. What the host configs ask for"
python3 - <<'PY' 2>/dev/null || say "  python3 unavailable — check the mcp entries by hand"
import json, os
from pathlib import Path

def report(label, command):
    verdict = "junon" if "junon" in str(command) else "SERENA — this is the bug"
    print(f"  {label}: {command}  -> {verdict}")

for name in ("~/.config/opencode/opencode.json", "~/.config/opencode/config.json"):
    path = Path(os.path.expanduser(name))
    if path.exists():
        try:
            entry = (json.loads(path.read_text()).get("mcp") or {}).get("serena")
        except ValueError:
            print(f"  {name}: not valid JSON")
            continue
        if entry:
            report(name, entry.get("command"))

claude = Path(os.path.expanduser("~/.claude.json"))
if claude.exists():
    try:
        data = json.loads(claude.read_text())
    except ValueError:
        data = {}
    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "serena" and isinstance(value, dict) and "command" in value:
                    report("~/.claude.json", [value.get("command"), *(value.get("args") or [])])
                walk(value)
    walk(data)
PY
say "  a config that reads correctly proves nothing on its own: the running process may predate it"

head2 "4. Is JUNON installed alongside Serena, and does it compose?"
venv="$HOME/.local/pipx/venvs/serena-agent"
if [[ -d "$venv" ]]; then
  say "  serena-agent venv: $("$venv/bin/python" -c 'import importlib.metadata as m; print(m.version("serena-agent"))' 2>/dev/null || echo '?')"
  if [[ -x "$HOME/.local/bin/junon" ]]; then
    say "  ~/.local/bin/junon: present"
  else
    say "  ~/.local/bin/junon: MISSING"
    verdicts+=("the junon command does not exist — inject it: pipx inject serena-agent -e <checkout>/integrations/serena --include-apps")
  fi
  "$venv/bin/python" - <<'PY' 2>/dev/null || verdicts+=("junon is not importable inside Serena's venv — it was never injected, or an upgrade dropped it")
import os
from junon.compose import compose
from junon.dashboard import JUNON_DASHBOARD_DIR
result = compose()
print(f"  compose(): {result}")
index = os.path.join(JUNON_DASHBOARD_DIR, "index.html")
print(f"  dashboard assets: {'present' if os.path.isfile(index) else 'MISSING — the index view falls back to Serena''s page'}")
print(f"    {JUNON_DASHBOARD_DIR}")
PY
else
  say "  no pipx venv for serena-agent at $venv"
  verdicts+=("Serena is not installed by pipx here — AGENT_SETUP §5 covers the install")
fi

head2 "5. Ask the agent itself, from inside your host"
say "  Call the tool  get_current_config  in the session that looks wrong."
say "    active tools contain ide_* ............ it is JUNON"
say "    active tools contain no ide_* ......... it is plain Serena"
say "  The 'Serena version:' line in that output also exposes a stale process: if it disagrees with"
say "  the version in step 4, the process predates the install and only a host restart fixes it."

head2 "VERDICT"
if [[ ${#verdicts[@]} -eq 0 ]]; then
  say "  Nothing here is wrong. If the tools are named serena_* — serena_ide_read_symbol and the like —"
  say "  that is the MCP server's name, not the program: the ide_* tools only exist under JUNON."
else
  for verdict in "${verdicts[@]}"; do say "  - ${verdict}"; done
  say ""
  say "  If a config in step 3 already says junon while step 2 shows serena, the fix is to restart the"
  say "  host application — not the session. MCP servers are launched at start-up and keep the command"
  say "  they were started with."
fi
