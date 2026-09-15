# Changelog

What changed in each release, and what you have to do about it. Versions follow `VERSION` at the
repository root; every half of the product carries the same number, and a guard in each stack fails
when one drifts (see [AGENTS.md](AGENTS.md) §10).

**Updating**, whichever release you are on:

```bash
scripts/install-jetbrains-plugin.sh    # every JetBrains IDE on the machine, then restart them
pipx upgrade serena-agent              # JUNON, if it was installed from the git URL
pnpm -r build                          # the daemon and the CLI, then restart the daemon
```

Both halves report what they are: `ide-bridge doctor` names any peer that is behind, and `ide_status`
tells the agent — and through it, you.

## 0.3.6

- **"Install the plugin" is no longer the advice when the plugin is already installed.** An IDE
  reports the plugin it loaded at start-up, so it keeps naming the old version for as long as it
  runs — however current its disk has become. The version card read that as out of date and asked
  for an install that answers "already current", burying the one step that would have fixed it at
  the end of the sentence. When every IDE on the machine already holds the artefact's plugin, the
  remedy is now: restart that IDE, and nothing else. A disk that really is behind still gets the
  install advice, and a stale daemon or a stale JUNON keep their own — different halves, different
  fixes.

## 0.3.5

- **`junon instances --stop`**, because quitting the agent host was not the whole answer and there
  was no other. A host's stdio children die with it — one second after it closes the pipe — but a
  shared instance is re-parented on purpose so that it outlives the session that started it, which
  left waiting out the idle period or `pkill` as the only ways to end one. The command stops every
  instance nobody is attached to and names the ones it refused to touch, because a session is doing
  someone's work and a version number is not a reason to take it away. Nothing is restarted: the
  next session in a project starts what it needs, on the installed JUNON.
- AGENT_SETUP §5 now states the three lifetimes and how each one ends, since "why did the update not
  take" has the same answer every time: a process runs the code it imported at start-up.

## 0.3.4

- **A shared instance left behind by an upgrade now goes as soon as it is free**, instead of sitting
  out its thirty idle minutes. Nobody is using it and nobody will — a new session does not attach to
  superseded code since 0.3.2 — so the wait achieved nothing except making an upgrade look as though
  it had not taken. A session still outranks a version: an instance with anyone attached keeps
  running, however old its code, because cutting a live connection to install a number is not a trade
  worth making. The check re-reads the version from disk on every tick, since a process decides its
  own version once, when it imports, and an upgrade is precisely the event it cannot otherwise hear.

## 0.3.3

- **The install button stops sending you to quit an IDE for nothing.** It asked whether an IDE was
  running before asking whether there was anything to install, so an IDE already carrying this exact
  plugin was reported as _"could not be written to because it is running: quit it and press this
  again"_. Now an IDE that already has the artefact's version is left alone, open or not — the two
  versions compared by reading `plugin.xml` on both sides rather than trusting a filename.
- **"Already current" is no longer headed "Not installed".** `ok` required something to have been
  installed, so the best possible outcome — every IDE already up to date, which is what pressing the
  button twice produces — read as a failure. The headline is now named by the outcome itself
  (`Installed`, `Already current`, `Partly installed`, `Not installed`, `Install failed`, `Nothing to
install`) instead of being squeezed out of a boolean. A running IDE that genuinely needs the plugin
  is still reported, and still tells you to quit it.

## 0.3.2

- **An upgraded JUNON is no longer handed back the instance running the old one.** A shared instance
  holds the code it imported at start-up and outlives its sessions on purpose, so the moment JUNON is
  upgraded the machine is running instances of the previous release — and a new session attached to
  one and ran it. That turned the version card's own advice into a loop: it said _restart the host
  and the session will pick up the current one_, the host restarted, `attach` found the same
  superseded instance by root, and the card said it again. Seen on a live dashboard the day the
  shared instance shipped. Matching the project root is no longer enough: a session attaches only to
  an instance running the installed JUNON. The superseded one is left to the sessions already on it —
  killing it would take work away from them — and it exits when they end. `junon instances` names it,
  and says what becomes of it.

## 0.3.1

- **An IDE now notices a daemon that starts after it.** A project opened while no daemon was running
  was refused once, at start-up, and never looked again — so the ordinary order of things (start the
  IDE, start the daemon by hand later) left the two unable to meet. Measured on 2026-09-15: GoLand
  open for ninety minutes with the plugin loaded, a daemon running beside it for eighty-seven of
  them, no adapter, and a dashboard correctly reporting that no IDE was attached. The plugin now
  keeps looking, and links itself within fifteen seconds of a daemon appearing. Only for the two
  refusals a daemon would settle: a refused handshake or registration is the daemon saying no, and
  retrying that on a timer is a flood. Unlinking outranks the watch — a decision is not undone
  behind your back.
- **The dashboard stops claiming a dead daemon is running.** It took the existence of the discovery
  file as proof, so a daemon that had stopped three weeks earlier still read as "Daemon running, no
  IDE attached" over an endpoint answering "connection refused". Liveness is now pid _and_ start
  time (ADR-0040), the same rule the rest of this product already used; a file left behind by a
  stopped daemon says so and names what to do, and a daemon whose process is alive while its
  endpoint is silent is its own state rather than a contradiction.

## 0.3.0

- **One JUNON per project, shared by every session on it.** Each agent session used to start its
  own JUNON — its own language servers, index and dashboard — and nothing ended it: ten were found
  running on one machine, four of them a week old and serving nobody. Now the hosts run
  `junon attach`, a thin stdio relay to one `junon serve` per project root, started on first use,
  pinned to that project, and gone after thirty idle minutes. Measured before it was built: two
  sessions on one instance, forty concurrent calls, zero wrong answers; a second session answers
  0.73 s after it is spawned. Details, numbers and what was learned in
  [docs/SHARED_JUNON_PLAN.md](docs/SHARED_JUNON_PLAN.md).

  **What you have to do:** change one word in each host's MCP configuration — the `serena` entry's
  command becomes `junon attach` (AGENT_SETUP §5 has all three hosts in full) — and restart the
  host. `junon instances` shows what is running; `ide_status` now says it too.

## 0.2.8

- **Every diagnostics snapshot came back incomplete.** A cancelled daemon pass cleared _every_
  document's finished state rather than the cancelled one — the platform names no document when it
  cancels, and it cancels constantly — so a document that had genuinely finished went back to pending
  seconds later, and `COMPLETED` was close to unreachable in a working IDE. The handler no longer
  clears anything: an edit already takes a document back to pending, and a cancel does not empty the
  markup model.
- The note on an empty, incomplete snapshot told the caller to open the file in the IDE. The adapter
  opens it itself before analysing, so the only correct advice was to ask again in a few seconds —
  and an agent cannot open an editor anyway. The wording, and the fact about the adapter it rests on,
  are both under test now.

- **The gate treats a session that uses the index differently from one that never has.** The
  whole-file budget is five for the first and three for the second; the second also gets one nudge on
  its first short source file, closing the case where a project of small files could be read entirely
  without the budget ever being spent. Giving up moves from two ignored refusals to three. `glob` was
  considered and deliberately left alone.

- **The gate's shell rule judges what a command is aimed at.** Two corrections, both found by using
  it: judging the verb alone refused `cat` on a YAML config, and judging the whole line then let
  `cd /tmp && grep -rn thing .` through while refusing `grep ERROR /var/log/x.log`. It is now scoped
  to the segment holding the command and asks where as well as what.
- **The file-tool gate stops being walked around, and stops nagging agents it cannot help.** Watched
  running for the first time, it fired five times and converted nobody: one agent ran `bash grep`
  instead, one repeated its call, and three belonged to an agent with no serena at all. `bash` searches
  and `cat`s are now refused on the first word of each `&&` segment, and a session that has never used
  a symbolic tool and has ignored two refusals is left alone until it does.

## 0.2.7

- **`scripts/update-all.sh` no longer contradicts itself.** Running it for real — the first time,
  against the 0.2.6 it had just built — it printed each running IDE twice, once as skipped and once as
  `FAIL`, and then declared every step verified. `InstallOutcome.failed` carries the running IDEs as
  well as genuine failures, and the Python block's findings never reached the shell's exit status.
  Running IDEs are now subtracted from the failures and real ones are counted.
- **The plugin report printed nothing at all** in the first fixed version: the file is bash and
  `print` is a zsh builtin. Two defects, both found by running the script rather than reading it,
  which is why 0.2.6 is superseded rather than amended.

## 0.2.6

- **The dashboard resources are packaged, and a JUNON without them says so.** A wheel built from
  `integrations/serena` carried every module and no `index.html`, which does not fail — the index view
  falls back to Serena's page. Someone following AGENT_SETUP hit exactly that and spent an afternoon on
  it. Three layers now: the `package-data` declaration, a test that builds the artefact and looks
  inside, and a banner on the served page naming the empty directory and the diagnostic to run.
- **`scripts/update-all.sh`** brings all three halves up in one command — pull, build, restart the
  daemon, install into every IDE that is closed — verifying each by reading the version back from the
  thing that changed, and listing what only a human can do.
- `*.egg-info/` is no longer tracked: it is rewritten by every build, so it dirtied the tree that the
  updater refuses to pull onto.

- **A JUNON older than its daemon is no longer reported as agreement.** The version check asked
  whether the daemon was older than this JUNON and never the reverse, so a long-lived agent session —
  which holds the JUNON it imported at start-up — showed "daemon and every adapter at 0.2.5" while
  being 0.2.4 itself. Found on a live dashboard. The remedy names the actual action: restart the
  agent host, since nothing installs a JUNON that is already the checkout.

## 0.2.5

- **Serena upgrades are now checked and reversible.** `scripts/upgrade-serena.sh` runs
  baseline → install → prove → roll back and prove again. The check is behavioural, because the
  repository's suite runs against the Serena _checkout_ and says nothing about the pipx venv that
  actually serves JUNON: it starts the real binary, proves via `lsof` that the port answering belongs
  to the process it started, and requires the `ide_*` tools to be registered. An installation that is
  already broken is refused rather than upgraded. Proved end to end against an isolated pipx home:
  1.7.0 -> 1.5.3 -> failure detected -> rolled back to 1.7.0 -> verified, with real pipx and the
  release that historically broke this composition.
- **The dashboard's release check covers Serena**, in the same click as the plugin repository.

- **A closed IDE is no longer a dead end.** Every `ide_*` refusal that means "there is no IDE to ask"
  now names the language-server tool that answers the same question — `find_symbol`,
  `find_referencing_symbols`, `get_diagnostics_for_file` — and the two that have no equivalent
  (`ide_apply_fix`, and reformatting in `ide_refactor`) say nothing rather than sending someone to a
  tool that cannot do it.
- **Auto-starting a headless IDE was measured and rejected**, and AGENT_SETUP §4 records why: it
  works — an adapter registered ten seconds after `remote-dev-server.sh run`, with no window — but it
  costs 2.1 GB per backend, opens a Code With Me listener with a join token as a side effect of
  activating a project, and the flag that skips the trust prompt also runs build scripts.

- **A gate that makes the agents use the tools, since telling them did not.** `scripts/install-agent-gate.sh`
  installs an opencode plugin and a Claude Code hook that refuse a bare-identifier `grep` and a
  ranged-less `read` of a code file over 300 lines — once per target, naming the symbolic call that
  answers better. Repeating the call runs it, so nothing is unreachable and no agent can be trapped.
  AGENT_SETUP §7 now records the measurement that made this necessary: two days after the prompts
  were rewritten to insist on the symbolic tools, the search agent made 319 calls and none of them
  was a Serena call.
- **A per-session budget, because the size rule alone barely bit.** Replaying a fortnight of recorded
  calls through the gate showed it would have refused 13.6% of the search agent's — and let through
  841 reads of code files under 300 lines, which is where the waste actually is. The sixth whole-file
  code read in a session is now refused once. Swept before choosing: at five the search agent goes to
  22.5% while the agent that already reads by range moves 6.4% to 7.4%.

## 0.2.4

- **A manual check for a newer release.** Every comparison until now was between things already on
  this machine, so a daemon, a CLI and three plugins all at 0.2.1 agreed with each other however long
  0.2.4 had been published. The dashboard's _Check for a new release_ button and
  `ide-bridge doctor --check-updates` ask the plugin repository — one `GET` of a public file, only
  when asked, nothing about this installation in the request, and _could not ask_ is never rendered
  as _up to date_. See SECURITY.md §5a.
- **A stale daemon is no longer invisible with every IDE closed.** `doctor` returned
  `versions: skip` whenever no adapter was registered, which threw away the one comparison that needs
  no adapter — the daemon against the CLI it shipped with. That is precisely the state a daemon left
  running across an update is in.
- **The dashboard's disk verdict now really compares against the daemon.** `base.get("daemonVersion")`
  had never returned anything: the key was read in two places and set in none, so the comparison
  silently fell back to JUNON's own version.

## 0.2.3

- **The toast can close the IDEs it needs to write to** — by asking, never by killing. A second button
  appears only when an IDE actually blocked the install, names it, and asks for confirmation first: the
  IDE is requested to quit the way its own menu does, so it saves, may prompt, and may refuse. It is a
  separate parameterless route rather than a flag, because "this endpoint takes nothing from the
  caller" is one of the four things keeping the button from being a back door.

**The instruction people read.** The remedy told a human to run `installPlugins`, a command measured
the same day to be incapable of replacing an existing plugin — so it named a path only someone in the
checkout could use, to run something that exits zero and does nothing. It now says what to do: quit
the IDE, then press the button or run the one script that does every IDE at once.

- A running IDE no longer turns a partial success into "Not installed": it is a reason, not a failure.

## 0.2.2

- **The install button installs.** It delegated to the IDE's `installPlugins`, which installs a plugin
  that is absent and refuses to replace one that is present — _"already installed"_, exit code 0,
  nothing written. Every press after the first was a no-op. It now unpacks the artefact, which is what
  the script does and what was measured working; the launcher stays for an IDE with no plugin at all.

- **The daemon can now be named as the stale half.** Every comparison measured peers _against_ the
  daemon, which made it correct by construction: a 0.2.1 daemon serving 0.2.1 plugins reported
  agreement while the rest of the installation had moved on. Both surfaces gained the reference they
  lacked — JUNON's own version for `ide_status` and the dashboard, this CLI's for `doctor` — and both
  say to rebuild _and restart_, since a rebuild alone changes nothing.

**The update surface people actually see.** 0.2.1 could be announced; this is the release that says so
where you are looking.

- The JUNON dashboard raises a **toast** when the halves are out of step, with an **Install now**
  button. The button is guarded — a token minted per process and sent in a header, an `Origin` check,
  no parameters, and the IDE's own `installPlugins` rather than a shell string — because a page on
  127.0.0.1 that executes is a door.
- It reports what actually changed, not what exited zero: `installPlugins` returns 0 against a running
  IDE and writes nothing, so the plugin version is read off disk before and after. Running IDEs are
  named as such rather than called failures.
- Every answer ends with how to check it took, because an installed plugin is not a loaded one.
- The agent-facing instructions changed shape: an opening move rather than a prohibition, a fallback
  that must be justified in one line, and the reason stated in terms an agent can verify.

## 0.2.1

**The first release an IDE can be told about.** Everything needed for an update notification existed
except a version higher than the one installed and a URL that answers; both are here.

- The plugin repository is published at
  `https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml`. Add it once per IDE —
  or let `scripts/install-jetbrains-plugin.sh` do it — and that IDE can offer future versions itself.
  Verified end to end: `installPlugins com.idebridge.jetbrains` resolved the plugin from that
  repository and installed it into a PyCharm that had never seen it.
- `scripts/ensure-plugin-repository.sh` writes the repository two ways, because they fail
  differently: `idea.properties` → `idea.plugin.hosts`, which the IDE never rewrites, and
  `options/updates.xml` → `pluginHosts`, which a **running** IDE erases from memory on exit — measured
  twice here.
- The JUNON dashboard's **IDE Bridge card** now states whether the halves are the same release, and
  the command to run when they are not — the surface for someone who opens neither a terminal nor an
  agent.
- `ide_status` now reports the version of the daemon and of every connected plugin, with the command
  to run when they differ. Nothing else could say it: an IDE updates its plugin without knowing a
  daemon exists, and `pipx` updates JUNON without knowing either.

**Restart what you update.** A plugin and a repository URL are both read at start-up; an IDE running
at the moment you install has neither.

## 0.2.0

**One version for the whole product, and the machinery to notice a mismatch.** Seven declarations of
the version existed and no two agreed — the daemon said `0.0.0`, the plugin's constant `0.1.0` while
Gradle built `0.1.0-SNAPSHOT`, JUNON sent a literal `0.1.0` from a package calling itself `0.0.0`.
Nothing could be compared, which is why no update signal of any kind was possible.

- `VERSION` at the root is the number; every copy is held by a test.
- `ide-bridge doctor` gains a `versions` check that names the peers that are behind rather than
  counting them, because a plugin is installed per IDE.
- `ide_refactor` — the IDE's own rename, reachable from Serena for the first time. `rename`,
  `reformat` and `optimizeImports` were served by both adapters and reachable by nobody.
- The JetBrains plugin builds on **JDK 21 or newer**; the bytecode stays at 21, because PhpStorm
  2025.3 still runs JBR 21 and refuses anything above.
- The JetBrains tool window says when no JUNON dashboard is running instead of hiding its link.
