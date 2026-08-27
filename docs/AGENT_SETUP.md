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

### Why nothing here starts an IDE for you

A closed IDE is the ordinary case, and the obvious idea is to start one on `activate_project`. It was
measured rather than argued about, because JetBrains does ship a headless backend on macOS:

```bash
PyCharm.app/Contents/bin/remote-dev-server.sh run /path/to/project
```

It works. The plugin loads, and an adapter registered with the daemon **ten seconds** after launch,
with no window. It was rejected anyway, on what the same run showed:

- **2.1 GB resident** for one backend. A polyglot repository would invite one per language, which is
  six gigabytes to answer a question about a symbol.
- **It opens a Code With Me listener** (`tcp://127.0.0.1:5990`) and prints a join link carrying a
  token, plus Gateway links carrying the machine's hostname. Loopback, but it is a remote-access
  surface appearing as a side effect of activating a project — and a log line not to paste into an
  issue.
- **`REMOTE_DEV_TRUST_PROJECTS` is not an option.** It skips the trust prompt *and* runs build
  scripts with it. Workspace trust is not something this project disables silently.
- **A registered adapter is not a ready one.** Ten seconds to appear; indexing is separate, so the
  first calls after an automatic start would refuse as not-ready anyway.

So the IDE is worth its memory when you already have it open — for unsaved buffers, its inspections
and its refactoring engines — and when it is closed the answer is not to resurrect it. Every `ide_*`
refusal that means "there is no IDE to ask" now names the tool that answers the same question through
a language server:

| Closed-IDE refusal from | Names |
| --- | --- |
| `ide_find_symbol` | `find_symbol(name_path_pattern=...)` |
| `ide_hierarchy` | `find_referencing_symbols(...)`, `find_implementations(...)` |
| `ide_symbols_overview` | `get_symbols_overview(relative_path=...)` |
| `ide_read_symbol` | `find_symbol(..., include_body=True)` |
| `ide_read_document` | `read_file` — with the difference stated: the disk has no unsaved edits |
| `ide_diagnostics` | `get_diagnostics_for_file(relative_path=...)` |
| `ide_todos` | `search_for_pattern(...)` |
| `ide_refactor` | `rename_symbol(...)`; reformat and optimiseImports have none, and it says so |
| `ide_apply_fix` | nothing, and it offers nothing — a quick fix is the IDE's inspection or it is not that fix |

## 5. Connect Serena (JUNON)

JUNON composes onto an **unmodified** Serena, so it must be installed into Serena's own environment.
There are two ways, and the difference is not cosmetic.

**To use it — install from the remote.** This is the one you want unless you are changing JUNON
itself:

```bash
pipx inject serena-agent \
  "git+https://github.com/Zall9/junon@v0.2.7#subdirectory=integrations/serena" --include-apps
```

Verified over that exact URL on 2026-08-27: version 0.2.7, the code in the venv rather than in any
checkout, `title: JUNON`, `/junon/ide-bridge/status` 200, ten `ide_*` tools, and no fallback banner —
which is the part that did not work before 0.2.7, because the wheel carried no dashboard and JUNON
served Serena's page instead.

**To develop it — install the checkout, editable:**

```bash
pipx inject serena-agent -e /path/to/junon/integrations/serena --include-apps
uv tool install serena-agent --with /path/to/junon/integrations/serena   # if Serena came from uv
```

`-e` means the installed package **is** the checkout: `import junon` resolves to your working tree, so
an edit reaches every agent host on the machine at its next restart. That is the point when you are
developing, and a liability when you are not — switching branches changes what your agents run, and a
half-finished edit breaks every session at once. Pin a tag instead unless you need the loop.

Whichever you choose, `--include-apps` is not optional: without it the entry points stay inside the
venv and `~/.local/bin/junon` never appears, so every host falls back to plain `serena`.

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
- **`.serena/project.yml` is not the last word.** `.serena/project.local.yml` overrides it, is not
  versioned, and on a machine set up before 1.7 still carries the old `languages:` key — which Serena
  honours by renaming it on load, so it silently wins over anything you write in `language_servers`.
  It cost three attempts here to find that. And the list matters more than it looks: **one language
  server that fails to start takes every symbolic tool down with it** — Serena reports it as the
  *manager* failing — so a server that needs a Gradle build to answer can leave a whole project with
  nothing but `read` and `grep`. Pin the list to what the LSP is actually good at, and leave the rest
  to the IDE, which is what `ide_find_symbol` is for.

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

An opencode plugin and a Claude Code hook, refusing what follows, **once per target** — the table
is the list, and carries no count beside it, because that count has already gone stale twice:

| Refused | Why | To proceed anyway |
| --- | --- | --- |
| `grep` for a bare identifier | a question about a symbol, which grep answers with every comment and string containing the name | repeat it, or use a regex |
| `read` of a code file over 300 lines with no range | the whole file enters the context to answer a question about part of it | repeat it, or pass offset/limit |
| the **sixth** whole-file code read in one session | no single one is wrong; opening thirty files to find one function is the search a symbol index does in one call | repeat it, or pass offset/limit |
| `bash grep`/`rg` for a bare identifier, `cat` of a source file | the shell is not a different question — it is the same one, asked where the gate could not see | repeat it, or point the command at something that is not source |

Both numbers were swept over a fortnight of recorded calls rather than chosen by taste — what share
of the calls that actually happened each setting would have refused:

```
> 300 lines, no budget      explorer 13.6%   fixer  5.9%   orchestrator 6.4%
> 300 lines, budget 5       explorer 22.5%   fixer 11.5%   orchestrator 7.4%   <- chosen
> 300 lines, budget 3       explorer 28.3%   fixer 16.3%   orchestrator 8.5%
> 150 lines, budget 3       explorer 33.6%   fixer 18.8%   orchestrator 12.8%
```

Five rather than three because `orchestrator` already reads by range 484 times a fortnight, and a
rule that starts punishing the agent doing it right is a rule that gets deleted.

### What it did on the first day, and what changed because of it

The gate was watched running before this section was rewritten, and it converted nobody:

```
grep "authentication"  refused -> the agent ran bash          (routed around it)
grep *.php             refused -> it repeated the same grep   (used the escape hatch)
read x3                refused -> nothing followed            (an agent with no serena at all)
```

Five refusals, zero symbolic calls. Both causes are in those three lines, and both are now closed.

**bash was an open door.** This section used to call that a deliberate hole, on the grounds that
closing it means parsing shell. It does not: reading the first word of each `&&`-separated segment
catches `cd /somewhere && grep -rn thing .`, which is the shape that was actually used. What remains
open is stated as a limit rather than a principle — quoting, subshells, aliases and anything cleverer
go through, because a gate that tries to understand shell is one that breaks a build at three in the
morning.

**Some agents cannot comply.** `gitlab-review-orchestrator` has no serena in its `mcps`, so a refusal
named a tool it could not call; three of the five were that. Neither host tells a hook which agent is
asking, so instead of mining configuration the gate watches the session: one that has never used a
symbolic tool and has now ignored **two** refusals is one it cannot help, and it goes quiet there. A
single symbolic call in that session clears the count and the nudges resume. The waste is bounded at
two round-trips, and no configuration decides it.

**What it never touches**, so the boundary is a fact rather than a discovery: `glob`, `list`, every
`read` that carries `offset`/`limit`, every file that is not source (markdown, JSON, lock files,
logs), every source file under 300 lines while the budget holds, every `grep` whose pattern is a real
regex or shorter than three characters, every path that cannot be read, every command that is not a
search or a `cat` — `git`, `pnpm`, `tail`, `ls` — and every `serena_*` call, which it observes rather
than judges.

The shell rule looks at **what a command is aimed at**, not only what it is, and it took two
corrections to get there. Judging the verb alone refused `cat .serena/project.yml` — a config file the
rule's own message promises to let through. Judging the whole command line then let
`cd /tmp && grep -rn thing .` past, because the token after `cd` is `&&`, while refusing
`grep ERROR /var/log/system.log`, which is a log question wearing an identifier's clothes. It is now
scoped to the segment holding the command and asks *where* as well as *what*: a bare identifier
searched across a tree is a symbol question; the same pattern pointed at a `.log` is not.

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

It registers the hook for `Bash|Grep|Glob|Read|Search|mcp__serena__.*`. The last of those is not
refused — it is *observed*: each hook call is its own process, so noticing that a session uses the
index is the only way the give-up rule above can know anything.

Claude Code refuses to let an agent edit its own hook configuration — correctly, since a tool that
can install its own hooks can install any hook.

**Then restart the host, and do not skip this.** Both hosts read plugins and hooks once, at start-up.
Installed here at 10:01 and still not firing at 12:16, because the opencode server answering had been
running since 23:40 two nights before: 39 tool calls in between, twelve of them `read`, and **zero**
refusals. Nothing was broken and nothing said so — the check is
`python3 integrations/agent-hosts/junon-usage.py --days 1`, and a gate that is working shows up as
refusals in the transcript, not as an absence of reads.

**To remove it:** delete `~/.config/opencode/plugin/junon-first.ts`, and the `junon-first-gate` entry
from `~/.claude/settings.json`. Both take effect on the next start of the host, for the same reason.

### "I get Serena's dashboard, not JUNON's"

Run this on the machine with the problem; it changes nothing and prints its evidence, so the output
can be pasted into a message:

```bash
scripts/diagnose-dashboard.sh
```

Three causes account for nearly all of it, and **only the first is visible in a config file**:

| Cause | How it looks | Fix |
| --- | --- | --- |
| The host launches `serena` instead of `junon` | no `ide_*` tools anywhere | correct the MCP entry, then restart the host |
| The host was fixed but never restarted | the config reads `junon`, the running process is `serena` | restart the host **application**, not the session — MCP servers are launched at start-up and keep the command they started with |
| It *is* JUNON | tools named `serena_ide_read_symbol` and the like | nothing is wrong: the prefix is the MCP server's name, and `ide_*` tools exist only under JUNON |

**Since 0.2.6 the page tells you itself.** When JUNON runs but its dashboard files are missing — an
install that did not carry its resources, a checkout without the front end — the served page carries a
banner saying it is Serena's, naming the directory that is empty, and stating that the `ide_*` tools
are unaffected. Before that, the only signal was a warning in a log the agent host swallows, which is
why this failure cost someone an afternoon.

Two checks settle it between them. From a shell, `/junon/ide-bridge/status` answers `200` on a JUNON
dashboard and `404` on Serena's — a page can be cached, a route cannot be faked. From inside the
session, call `get_current_config`: active tools containing `ide_*` mean JUNON, and the
`Serena version:` line it prints exposes a stale process when it disagrees with what pipx has
installed.

The second cause is the one that wastes an afternoon, because nothing is wrong with the file you keep
re-reading. Measured on this machine: a Claude Code MCP server started on 11 August was still serving
Serena 1.5.3 while `~/.claude.json` had said `junon` for a fortnight and pipx had moved to 1.7.0.

### The tray icon, and which instance you are looking at

Serena's `web_dashboard_interface` decides this, and the default (empty) is the right choice for a
JUNON setup:

- **`app`** gives a native window with a tray icon per process. Serena's own configuration file warns
  that on macOS this "may result in too many icons being displayed when using multi-agent setups", and
  that is not theoretical: measured here, **nine** MCP servers were alive at once — five from
  `opencode serve`, two from `opencode acp`, one from Claude Code, one from launchd. Nine tray icons.
- **`tray_manager`** collects every instance behind one icon, which is what a multi-agent setup wants,
  but Serena documents it as experimental and tested on Windows only.
- **Empty or `browser`** is what JUNON is set up against: reach the dashboard by URL, from the
  JetBrains panel link, or by asking the agent to open it.

Nothing about JUNON needs a tray icon, and a tray icon proves nothing about what is running: it opens
whatever *that* instance serves, which is JUNON's page when the composition applied and Serena's when
it did not. Ports climb with instances — 24282, 24283, 24284 — so the icon or URL you have may belong
to a process from yesterday. `scripts/diagnose-dashboard.sh` names the pid behind each port.

## 8. Keep Serena current without losing the composition

JUNON is composed onto an **unmodified** Serena, installed by pipx with JUNON injected into the same
venv as an editable package. Serena's releases therefore arrive from a channel that knows nothing
about JUNON, and that door has broken this machine twice: 1.5.3 changed the signature of
`run_in_thread` and JUNON's override killed the agent at start-up; a config schema change made 26 of
27 projects unloadable. Neither was visible in a version number.

```bash
scripts/upgrade-serena.sh --check      # what is installed, what is published
scripts/upgrade-serena.sh --dry-run    # what it would do
scripts/upgrade-serena.sh              # do it, with the rollback armed
scripts/upgrade-serena.sh --to 1.6.1   # a specific version, including going back
```

The same answer appears on the dashboard's **Check for a new release** button, which now reports both
halves — the plugin repository and the package index — in one click. The *upgrade* is deliberately not
a button: it takes minutes and its output has to be read.

What the script does, in order:

1. **Baseline.** Starts the real `junon` binary against your project and asks it which tools it
   registered. An installation that is already broken is **not** upgraded — the rollback would restore
   the same break and the run would report success.
2. **Install** the target version, then **re-inject** JUNON from the spec pipx recorded, including
   `--include-apps`. Without that flag the entry points stay inside the venv and `~/.local/bin/junon`
   disappears: a rollback that restores a working library and leaves nothing to run.
3. **Check again.** Same behavioural test.
4. **Roll back** to the version that was there if the check fails — and **check the rollback**, because
   a rollback nobody verified is the same unverified promise this script exists to stop.

Exit codes: `0` fine · `1` the upgrade did not hold and was undone · `2` the rollback did not restore
a working installation, which needs a human immediately.

**Proved, not asserted.** Run against an isolated pipx home (`PIPX_HOME=/tmp/pipx-probe`) so the live
installation was never touched, with real pipx and real releases:

```
before: 1.7.0
ok    composition       10 ide_* tools registered
ok    install           installed 1.5.3
FAIL  composition       the dashboard did not report its tools
rolling back
ok    reinject          .../integrations/serena
ok    rollback          restored 1.7.0
ok    after rollback    10 ide_* tools registered
```

1.5.3 is the release that broke this composition historically, and it still does — the failure above is
the real one, not a simulated one. Two defects were found by running it rather than reasoning about
it:

- **`pipx install --force` installed nothing.** pipx builds venvs with uv, and uv refuses to replace a
  directory it did not create in the current session: *"A virtual environment already exists at: ."*
  `--force` is pipx's flag and never reaches uv's refusal. Every install and every rollback now carries
  `UV_VENV_CLEAR=1`.
- **The rollback would have removed `~/.local/bin/junon`.** pipx records `include_apps` separately from
  `pip_args`; re-injecting without it restores a working library with no binary to run.

**The check is behavioural on purpose.** The repository's own suite runs against the Serena *checkout*
in `serena-upstream/`, not against the pipx venv that actually serves JUNON — a green suite says
nothing about the installation being changed. The smoke test starts the binary, waits for its
dashboard, proves with `lsof` that the port answering belongs to the process it just started (a JUNON
already running would otherwise answer for it, cheerfully, about the wrong process), and requires the
`ide_*` tools to be registered.

## 9. Redeploy after you change the source

```bash
scripts/update-all.sh          # --dry-run first, if you prefer
```

Three halves, three mechanisms, which is why doing this by hand goes wrong: the dashboard's Install
button copies the plugin into each IDE and touches nothing else; the daemon runs a build from this
checkout and keeps the code it started with until the process is restarted; JUNON is imported by each
agent host at start-up. The script pulls, builds, restarts the daemon, installs into every IDE that is
closed, and **reads each version back from the thing that changed** rather than from what it asked for.
It refuses to run on a dirty checkout, and it ends by naming what no script can do: restarting the
editor you are typing in, and the agent hosts whose sessions hold the JUNON they imported.


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
| `find_symbol` says *the language server manager is not initialized* | One server failed and took the rest with it. Pin `language_servers` to what you need — and check `.serena/project.local.yml`, which overrides `project.yml` and may still use the pre-1.7 key `languages:` |
| Serena dies at start-up, `KeyError: 'languages'` | The project config was written by Serena 1.7, the installed Serena is older. `pipx upgrade serena-agent`. Not a JUNON failure — plain `serena` fails identically, which is the control worth running before blaming the composition |
| `ide_*` tools exist but every call refuses | No adapter connected, or the workspace is not the one the IDE has open. The refusal names the language-server tool that answers without an IDE — see §4 |
| Empty symbol results on a real project | The project declares no source roots; the adapter reports this rather than guessing |
| Serena's dashboard is served, not JUNON's | Read the banner at the top of that page if there is one — it names the missing directory. Otherwise `scripts/diagnose-dashboard.sh`: usually a host never restarted after its config was corrected |
| Tools are named `serena_*` and it looks like plain Serena | That is the MCP server's name. If `serena_ide_*` tools exist, it is JUNON |
| No JUNON dashboard link in the JetBrains panel | Nothing published one — the panel now says so in place of the link |
| A source change has no effect anywhere | Nothing was redeployed. Step 9 — the plugin is a built jar, and the editable install may point at a different checkout |
| A dashboard link opens something that is not a dashboard | A stale entry whose pid was reused. Entries predating the `started_at` field are trusted on their pid alone; `rm -f ~/.ide-bridge/dashboards/*.json` once, with nothing running |
| A file changed on disk is not visible to reads | Up to ~15 s: an unfocused IDE only refreshes when asked, and the adapter asks on a timer |
| A `read` or `grep` came back refused, naming a `serena_*` call | The gate, working. Make the call it names, or repeat yours — the second attempt always runs. §7 |
| The gate never refuses anything | The host has not been restarted since it was installed; plugins and hooks are read at start-up. `python3 integrations/agent-hosts/junon-usage.py --days 1` |
| A refusal names a tool the agent does not have | That agent's `mcps` list excludes `serena`. Repeat the call to proceed, then add it — the gate assumes what §7 installs |
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
