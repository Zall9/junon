# Setting this up, for a coding agent

You are setting up three processes that must find each other: a **daemon**, at least one **IDE
adapter** connected to it, and a **consumer** (JUNON on Serena, or your own client). The daemon is
the fixed point — start it first, and everything else discovers it through one file.

Work through the steps in order. Each one ends with something to check. **Do not proceed on a step
whose check you did not see pass**: every hard-to-diagnose failure in this project's history came
from assuming a step worked, and the failures below are silent by nature — a wrong daemon answers
just as promptly as the right one.

---

## 0. Preconditions

| | |
| --- | --- |
| Node | 24 (`node --version`) |
| pnpm | 10 (`pnpm --version`) |
| Python | ≥ 3.12, only for the Serena integration |
| JDK 21 or newer + Gradle ≥ 9 | only for the JetBrains adapter. The build emits Java 21 bytecode whichever JDK you use — that part is fixed by the oldest IDE it must load into |

macOS and Linux. The discovery file is written with POSIX permissions and Windows is not supported.

## 1. Build

```bash
pnpm install
pnpm -r build
```

**Check:** `packages/cli/dist/bin.js` exists. Everything below runs it directly; there is no global
install and you should not add one.

## 2. Start the daemon

**Use the default discovery file unless you have a reason not to.** The daemon writes its endpoint
and token to `~/.ide-bridge/discovery.json`, mode `0600`, and that is the path an IDE reads when it
was started normally — from the Dock, a launcher, or Toolbox. Measured on this machine: a running
PhpStorm has no `IDE_BRIDGE_DISCOVERY_FILE` in its environment at all, because a GUI application
inherits nothing from your shell. Point the daemon somewhere else and that IDE will still look in
the default place and find whatever is there — nothing, or worse, something old.

```bash
node packages/cli/dist/bin.js daemon
```

**It does not return.** It is a foreground server: measured, still running four seconds later, and a
shell that starts it without `&` never gets its prompt back — which for an agent means the command
never returns and the setup stops there. Run it detached, and keep the log:

```bash
nohup node packages/cli/dist/bin.js daemon > ~/.ide-bridge/daemon.log 2>&1 &
```

Set `IDE_BRIDGE_DISCOVERY_FILE` only to *isolate* a daemon — a demo, a sandbox IDE started from the
same shell, two experiments at once. Then every shell **and** the IDE must be started with it
exported, or you have made exactly the split this step exists to avoid.

**Check**, from any shell:

```bash
node packages/cli/dist/bin.js status
```

```json
{"ok":true,"command":"status","result":{"daemonVersion":"0.0.0","protocol":{"minimum":"0.1.0",
 "maximum":"0.1.0"},"startedAt":"…","uptimeMs":4012,"adapterCount":0,"workspaceCount":0}}
```

`adapterCount: 0` is correct here — no IDE has connected yet, and the daemon says so rather than
waiting for one to appear.

## 3. Identify the daemon before trusting it

```bash
node packages/cli/dist/bin.js doctor
```

Read the `daemon` block, not just the checks: `pid`, `discoveryFile`, `startedAt`, `uptimeSeconds`.

**Check:** the pid is the process you just started, and the uptime is seconds — not hours. A daemon
left running from an earlier session passes every check and answers every request, and telling the
two apart afterwards is nearly impossible. If the uptime is large and you did not intend that, stop
the old one before going on.

Read the `versions` check too. It is the only thing that compares the halves of this installation —
the daemon, and the plugin inside each IDE — and it names the ones that are behind rather than
counting them, because a plugin is installed per IDE and you need to know which one to reinstall. It
warns rather than fails: a peer one release behind usually works, and the handshake already refuses
what genuinely cannot. `skip` means no adapter has connected yet, which at this step is expected.

## 4. Attach an IDE

Do one of the two. Both can run at once against the same daemon — that is a supported configuration,
not a hack.

### JetBrains

```bash
cd jetbrains-plugin
export IDE_BRIDGE_SAMPLE_PROJECT=$PWD    # or any project with source roots
./gradlew runIde                          # runPyCharm / runGoLand / runPhpStorm too
```

The sandbox IDE inherits this shell, so it finds the daemon from step 2 at the default path with
nothing exported. **If** you isolated that daemon with `IDE_BRIDGE_DISCOVERY_FILE`, export the same
value here — a sandbox pointed at a path where no daemon is listening reports no daemon, correctly
and unhelpfully.

For the IDEs already on the machine, do not drive the dialogs — run:

```bash
scripts/install-jetbrains-plugin.sh --dry-run    # what it would touch
scripts/install-jetbrains-plugin.sh              # build, install, configure
```

It installs into every IDE whose build satisfies the plugin's `since-build`, skips the ones below it
by name, and gives each a plugin repository so future versions announce themselves. Then **each of
those IDEs must be restarted once**: a plugin and a repository URL are read at start-up, so an IDE
running at that moment has neither. This is the ordering that hid the update badge here — an IDE was
restarted *before* the setting existed, and its `LAST_TIME_CHECKED` still predated the change.

Such an IDE, launched from the Dock, reads the default discovery file — which is where step 2 put the
daemon, so there is nothing to export. That is the whole reason step 2 uses the default: an IDE you
start normally cannot be told anything by a shell.

**Checks that need no GUI.** Both settings are files, so read them rather than asking someone to open
a dialog:

```bash
grep idea.plugin.hosts ~/Library/Application\ Support/JetBrains/*/idea.properties
```

Both should name:

```
https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml
```

`options/updates.xml` → `pluginHosts` is what the *Manage Plugin Repositories* dialog writes and what
the IDE loads into memory at start-up. A **running** IDE rewrites that file from its own memory, so an
entry written under one is erased — measured here, twice. `idea.properties` →
`idea.plugin.hosts` is written as well because the IDE never rewrites that file.

**If an IDE still shows no update**, the deterministic fix is order, not configuration: quit it, write
the settings entry while it is closed, and start it again — then the repository is in memory from the
first second. Opening *Settings → Plugins* also forces a poll rather than waiting for the IDE's own
interval, which can be a day.

A project **links itself when it opens**; there is nothing to click. The *IDE Bridge* tool window
shows one row per open project with its state, and a refusal states its reason there and in the log.

**The project must declare source roots.** A directory opened with none has no index and no
analyser, and the adapter says so rather than returning empty answers that look like real ones.

### VS Code

```bash
cd packages/vscode-extension
pnpm package        # dist/ide-bridge.vsix; install with: code --install-extension dist/ide-bridge.vsix
```

The extension does **not** take its configuration from the environment the same way: it reads the
`ideBridge.discoveryFile` setting first, and only falls back to `IDE_BRIDGE_DISCOVERY_FILE` when that
setting is empty. Set the setting when in doubt. `ideBridge.autoStartDaemon` is `true` by default, so
an editor that finds no daemon will start one of its own — convenient, and a second way to end up
talking to a daemon you did not start.

To verify the whole adapter without wiring anything, `pnpm test:integration` downloads VS Code,
installs the extension, opens a fixture project and drives the walkthrough itself.

**Check**, from your shell:

```bash
node packages/cli/dist/bin.js adapters
node packages/cli/dist/bin.js workspaces
```

`adapters` must list the IDE build you just started, and `workspaces` the project you opened. If
`adapters` is empty, the IDE is looking at a different discovery file — go back to step 2 rather than
restarting things at random.

## 5. Connect Serena (JUNON)

JUNON composes onto an **unmodified** Serena, so it must be installed into Serena's own environment:

```bash
pipx inject serena-agent integrations/serena --include-apps     # if Serena came from pipx
uv tool install serena-agent --with integrations/serena          # if it came from uv tool
```

**Check:**

```bash
junon tools list | grep '^ \* `ide_'
```

Ten tools — the tenth is `ide_refactor`, the IDE's own rename. Zero means plain Serena answered.

Then configure your MCP host to run **`junon`**, never `serena`:

```json
{
  "type": "stdio",
  "command": "junon",
  "args": ["start-mcp-server", "--project-from-cwd", "--transport", "stdio"]
}
```

**Check the Serena you are composing onto, not just the one this repository pins.** JUNON is
developed against the `serena-upstream` checkout here, and a machine's own Serena is usually older.
Two things follow, both measured on this machine rather than imagined:

- Serena 1.7 renamed the project-config key `languages` to `language_servers`. A project opened once
  by a 1.7 checkout has a `.serena/project.yml` that **1.5.3 cannot read**, and the server dies on
  start-up with `KeyError: 'languages'` — for `serena` and `junon` alike. Developing this project
  therefore breaks an older everyday Serena, quietly, in every repository it touches. The fix is to
  bring the installed Serena up to the schema its configs are already written in
  (`pipx upgrade serena-agent`), not to rewrite the configs back.
- The dashboard start-up call also changed shape between those versions. JUNON accepts both, and
  `tests/test_dashboard_start_shapes.py` is what keeps it that way.

This is the one step with no error message when you get it wrong. `serena` still starts plain Serena
— deliberately, so that installing JUNON cannot change a machine's behaviour silently — which means a
host pointed at `serena` gets the same tool names, no `ide_*` tools, no dashboard, and no complaint.
Most MCP hosts read this configuration at start-up only: restart the session after changing it.

## 6. Verify end to end

Call `ide_status` through your agent. It reports whether an IDE is connected and what it has open.
That is the only check that exercises the whole chain — consumer, daemon, adapter, IDE — and it is
the one to run before concluding that anything else is broken.

## 7. Make the agent actually use it

Installing the tools is not the same as them being used, and the difference is measurable. On this
machine, one search agent over 332 sessions:

```
12 332 tool calls   6 609 read · 1 648 grep · 864 glob · 1 731 serena
```

Its prompt had said *"Do NOT use read/glob/grep when Serena can do the job"* the whole time. An
instruction ignored six thousand times is not an instruction — it is a preference at the end of a
thirty-kilobyte prompt, competing with a tool that is right there and easier.

**Removing the tool works, and costs more than it looks.** `{"tools": {"read": false}}` per agent
makes the rule a mechanism, and it was tried here. But an agent that cannot read a lock file fails in
a new way, `bash` leaves the ban leaky anyway, and a subagent that hits a Serena outage has nowhere to
go. It is the right lever for an agent with one narrow job, and the wrong default.

**What to write instead of a prohibition**, in the order models actually respond to:

1. **An opening move, not a ban.** "Do NOT use read" competes with a tool in reach. A numbered first
   step competes with nothing: status, then locate by symbol, then read one declaration, and only
   then a whole file.
2. **A cost on the fallback.** Reading stays allowed and has to be justified in one line in the
   report — *"read pnpm-lock.yaml: not code"*. A habit that must be written down stops being a habit.
3. **The reason, once, in terms an agent can check.** Not "Serena is faster" but what a grep cannot
   do: resolve an override, tell a comment from a call, or see the buffer the editor holds while
   someone is typing.

**Order the tools, not just permit them.** The same measurement showed that when that agent did reach
for Serena, its most-used call was `serena_read_file` — reading whole files through a symbol-aware
server. Reading is the last rung of the ladder, not the first.

**Then check, because none of this is self-evidently effective**: opencode records every tool call in
`~/.local/share/opencode/opencode.db`, so the ratio is a query rather than an impression.

```bash
python3 integrations/agent-hosts/junon-usage.py --days 2
```

### It was checked, and the advice above did not work

The prompts were rewritten as this section recommends — an opening move, a cost on the fallback, the
reason stated in checkable terms. Two days later, per agent:

```
explorer      319 calls   junon   0  (0.0%)   file 272 (85.3%)
fixer         318 calls   junon  34 (10.7%)   file 230 (72.3%)
orchestrator  756 calls   junon  15  (2.0%)   file 187 (24.7%)
oracle        173 calls   junon 100 (57.8%)   file  37 (21.4%)
```

`explorer` had been at 10.8% over the preceding fortnight. Being told twice, in two files, took it to
**zero**. One agent out of four moved the right way, which is what an intervention with no mechanism
behind it looks like.

### What replaced it: a refusal that names the alternative

```bash
scripts/install-agent-gate.sh          # --dry-run first, if you prefer
```

An opencode plugin and a Claude Code hook, refusing exactly two calls, **once per target**:

| Refused | Why | To proceed anyway |
| --- | --- | --- |
| `grep` for a bare identifier | a question about a symbol, which grep answers with every comment and string containing the name | repeat it, or use a regex |
| `read` of a code file over 300 lines with no range | the whole file enters the context to answer a question about part of it | repeat it, or pass offset/limit |

The refusal names the call that answers better — `find_symbol`, `find_referencing_symbols`,
`ide_read_document`. **Repeating the call runs it**, so nothing is ever unreachable: a log file, a
genuine text search, a file outside any project all go through, most on the first attempt. That is
the difference from `{"tools": {"read": false}}` above — a ban an agent cannot escape becomes a new
failure, and this one always has an exit.

Two things it is careful about. It fires only where the symbolic route genuinely wins, so a short
file, a ranged read, a regex and a missing path are never touched. And it fails open: any error
inside the gate ends in "allow", because a gate that blocks the agent when its own logic breaks is
worse than no gate.

The Claude Code half needs one line registered in `settings.json`, and the installer will not write
it for you:

```bash
python3 ~/.claude/hooks/register-junon-gate.py
```

Claude Code refuses to let an agent edit its own hook configuration — correctly, since a tool that
can install its own hooks can install any hook. Restart the host afterwards; hooks are read at
start-up. To remove the gate: delete the plugin file, and the `junon-first-gate` entry from
`settings.json`.

## 8. Redeploy after you change the source

Editing a file changes nothing that is running, and neither half of this tells you so. Do the half
you touched — or both, if you changed something they share, such as the format of a file one writes
and the other reads.

**The plugin is a built jar.** `runIde` in step 4 compiles from source every time, so a change is
live on the next `runIde`. An IDE you already had is not: it holds the jar you installed.

```bash
cd jetbrains-plugin && ./gradlew buildPlugin
```

Then *Settings → Plugins → ⚙ → Install Plugin from Disk* with
`build/distributions/ide-bridge-jetbrains-*.zip`, **once per IDE** — installing in GoLand does
nothing for PhpStorm — and restart the IDE.

**The Python side is usually an editable install**, so the injected package points at a checkout
instead of copying it. Confirm which checkout, using **Serena's** interpreter rather than whatever
`python` resolves to:

```bash
~/.local/pipx/venvs/serena-agent/bin/python -c "import junon.dashboard_registry as m; print(m.__file__)"
```

If that path is not the tree you edited — a git worktree on a branch is a different tree from the
checkout it came from — your change is not in the running system no matter how green the tests are.
Where it is the right tree, the change lands on the next **JUNON restart**; a running agent keeps the
module it imported at start-up.

**Check:** re-run the step-6 verification, not the unit tests. Tests prove the source; only
`ide_status` proves what is loaded.

---

## When something does not work

| Symptom | Cause to check first |
| --- | --- |
| `adapterCount: 0` with an IDE running | The IDE and your shell are using different discovery files |
| Everything passes but answers look stale or wrong | A daemon from an earlier session. `doctor`, and read `pid` and `uptimeSeconds` |
| Agent has no `ide_*` tools | The host is running `serena`, not `junon` |
| Serena dies at start-up, `KeyError: 'languages'` | The project config was written by Serena 1.7, the installed Serena is older. `pipx upgrade serena-agent`. Not a JUNON failure — plain `serena` fails identically, which is the control worth running before blaming the composition |
| `ide_*` tools exist but every call refuses | No adapter connected, or the workspace is not the one the IDE has open |
| Empty symbol results on a real project | The project declares no source roots; the adapter reports this rather than guessing |
| No JUNON dashboard link in the JetBrains panel | Nothing published one — the panel now says so in place of the link |
| A source change has no effect anywhere | Nothing was redeployed. Step 7 — the plugin is a built jar, and the editable install may point at a different checkout |
| A dashboard link opens something that is not a dashboard | A stale entry whose pid was reused. Entries predating the `started_at` field are trusted on their pid alone; `rm -f ~/.ide-bridge/dashboards/*.json` once, with nothing running |
| A file changed on disk is not visible to reads | Up to ~15 s: an unfocused IDE only refreshes when asked, and the adapter asks on a timer |
| Answers look right but behave oddly | The halves may be different releases. `doctor` names the `versions` check; see [RELEASING.md](RELEASING.md) |
| Everything agrees, and everything is old | Local checks compare this machine against itself, so they cannot see a release nobody fetched. `node packages/cli/dist/bin.js doctor --check-updates` asks the repository — one `GET`, only when you type it |

## Rules that are not yours to relax

- The daemon binds loopback only. Do not expose it, tunnel it, or bind it to another interface.
- Never log or echo the token, and never paste the discovery file into an issue or a commit.
- No method executes shell commands or evaluates code in the IDE. If a task seems to need that, it
  is out of scope — say so rather than adding it.
- Do not modify `TASK.md`; it is the authoritative scope.
- A refused `read` or `grep` naming a `serena_*` call is the gate, not a broken tool. Make the call it
  names, or repeat yours — the second attempt always runs. Do not route around it with `bash cat`.
- Nothing here reaches the network on its own. `--check-updates` and the dashboard's *Check for a new
  release* button are the only outbound requests in the product, and both are things a person types
  or clicks. Do not add a check on start-up, on a timer, or "while we are here" — the guarantee is
  that a machine which never asks never sends anything ([SECURITY.md](SECURITY.md) §5a).
- Never push, publish, open a PR, or touch any remote.

`AGENTS.md` holds the full development rules, [STATUS.md](STATUS.md) what is actually verified, and
[DEMO.md](DEMO.md) the same walkthrough with each step's measured output.
