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

## Unreleased

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
