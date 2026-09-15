# One click, then nothing else: making an update take by itself

**Status:** done — shipped as 0.3.7 on 2026-09-16, after the whole sequence was run once on a
real machine with nothing typed between the click and the result.

## 1. The goal, in the user's words

> l'utilisateur clique sur installer → quitte les IDE → tout fonctionnera à 100 % à coup sûr sans
> autre interaction

One click on the dashboard's install button, the IDEs quit and reopened, and every half of the
product is on the new release — with nothing else to type, read or decide.

## 2. What a click reaches today — measured 2026-09-16

| Half | Reached by the click? |
| --- | --- |
| The plugin in each JetBrains IDE | **Yes.** `quit-and-install` asks each IDE to quit, then unpacks the artefact. |
| The shared JUNON instances | **No.** The route never mentions them. Each keeps the code it imported. |
| The daemon | **No**, and worse: nothing anywhere starts one. `grep` over the whole of `jetbrains-plugin/src/main` finds no `ProcessBuilder`, no `GeneralCommandLine`, no `Runtime.getRuntime` — the plugin only ever *connects*. Only `packages/vscode-extension` can spawn one (`autoStartDaemon`, `spawnOwnedDaemon`). |
| The relay processes (`junon attach`) | **No.** Each runs the relay code it imported; only a host restart replaces that. |

The daemon is therefore the half that no one owns. It kept running its old build through every
release today, and when the disk filled and it died, nothing brought it back — an IDE sat beside a
dead daemon for ninety minutes.

## 3. Belt and braces

Two independent mechanisms, so that no single one failing leaves the machine broken.

- **Braces — the click.** The install button, having installed the plugin, also refreshes the two
  halves it can reach from here: it stops every shared JUNON instance (safe since the relay
  reconnects), and restarts the daemon from the build recorded at install time.
- **Belt — the plugin.** An IDE that finds no usable daemon starts one itself, from the same
  recorded command. This is the half that covers what a click cannot: a daemon that dies at three in
  the morning, or a machine where nobody presses anything.

**How either of them knows what to run.** The installer — the one program that is, by definition,
running from a checkout with a built daemon — writes the command into `~/.ide-bridge/daemon.json`:
the node binary, the CLI path, and the version it was built from. Both mechanisms read that file.
Nobody has to guess, and a machine with no checkout simply has no file and says so instead of
failing obscurely.

**That file is executed, so it is treated as a credential.** Refused unless it is owned by this user
and writable by nobody else, exactly as the discovery file already is (SECURITY.md §3). A plugin
that runs a command from a world-writable file is a local privilege escalation, and this must not
become one.

## 4. Phases

### Phase 1 — The click refreshes JUNON

**Status:** done 2026-09-16 — `update_action.apply_release`, `tests/test_apply_release.py`

The install route stops every shared instance, including the busy ones, now that a relay follows its
instance. Sessions land on the new code at their next call.

**Acceptance:** with a live session attached, pressing the button leaves no instance from before the
click, and the session's next tool call is answered normally by a new one.

### Phase 2 — The daemon's command is recorded, and the click restarts it

**Status:** done 2026-09-16 — `junon/daemon_command.py`, `junon/daemon_control.py`, and the
recording added to `scripts/install-jetbrains-plugin.sh`. Proved live: daemon 76325 stopped, 86360
started and answering, `doctor` agreeing — and **PhpStorm relinked itself within five seconds**, the
0.3.1 watch doing its half with nothing typed.

`scripts/install-jetbrains-plugin.sh` and the dashboard's install both write
`~/.ide-bridge/daemon.json` (0600). The install route then stops the running daemon and starts the
recorded one, detached, and waits until it answers.

**Acceptance:** after a click, `doctor` reports the daemon at the installed version, its pid
different from before; with no `daemon.json`, the answer says so and changes nothing.

### Phase 3 — An IDE with no daemon starts one

**Status:** done 2026-09-16 — `connection/DaemonStarter.kt`, wired into `link()`;
`DaemonStarterTest` (8) and `StartsItsOwnDaemonTest` (2, one of them starting a real daemon from a
project that had none)

The plugin, when `DiscoveryReader` yields no usable daemon, reads `daemon.json`, checks its
ownership and permissions, and starts it — then links as usual. Refusals are reported in the tool
window like any other.

**Acceptance:** no daemon running, open a project → within seconds an adapter is registered against
a daemon the IDE started. A `daemon.json` owned by another user, or group-writable, is refused and
named. Killing the daemon under a running IDE is recovered by the existing watch plus this.

### Phase 4 — The click says whether it worked

**Status:** done 2026-09-16 — `update_action.verify`, carried in the answer as `verified` and as
the last sentence of `next`

The install answer ends with the verdict rather than instructions: every half at one version, or
precisely which is not and why.

**Acceptance:** the reported verdict matches what `doctor` says at that moment, in both the good
case and a deliberately broken one.

### Phase 5 — Release

**Status:** done 2026-09-16 — **0.3.7**, tag `v0.3.7`, commit `6c6372c`.

The sequence was run once for real, and this is what it produced:

| Step | Measured |
| --- | --- |
| The click | Both IDEs quit; PhpStorm moved 0.3.6 → 0.3.7 (its jar rewritten at 01:14:45); daemon 91846 stopped, 91848 answering; the instance serving the page survived to deliver the answer |
| Reopening the IDEs | GoLand and PhpStorm both loaded 0.3.7; **seven adapters registered within five seconds**, with nothing typed |
| The verdict | `Verified: daemon and every adapter at 0.3.7, with an IDE attached. Nothing left to do.` |
| `doctor` | `ok: true`, `adapters: registered-and-ready`, `versions: all-at-0.3.7` |

**What pressing it for real found, that the tests had not.** The sequence stopped the instance
serving the dashboard, so the page died mid-answer and the steps after it ran in a shutting-down
process — leaving the machine with no daemon, the worse end of what the click exists to fix. And the
headline said "Already current" while a plugin was being replaced in that very click, with nothing
recorded well enough to explain it. Both are fixed; the second is why every click now writes a line
saying what it did.

## 5. Risks and decisions

| Risk | Decision |
| --- | --- |
| A file that names a command to execute | Refused unless owned by this user and not writable by group or others; the plugin reports the refusal rather than running it |
| Two IDEs starting a daemon at once | The daemon already refuses a second instance on the same discovery file; the loser reads the file and connects |
| A daemon killed mid-session | Already covered: the plugin's watch relinks within fifteen seconds of one appearing (0.3.1) |
| The relay's own code is only replaced at host restart | Stated, not solved. It is thin, and nothing in Phases 1–4 changes it |
| A machine with no checkout | No `daemon.json`, no daemon started; both surfaces say so |

## 6. Update log

| When | What |
| --- | --- |
| 2026-09-16 | Plan written, after measuring that a click reaches only the plugin. The reconnecting relay (0.3.7, built and green, unreleased) is what makes Phase 1 safe. |
| 2026-09-16 | Phase 5 done: 0.3.7 released after the live sequence. Two defects that only a real click could show — the sequence stopping the process that owed the answer, and a headline contradicting the disk with nothing logged to settle it. The plan is closed; §5's two residuals stand. |
| 2026-09-16 | Phases 1–4 done. A click now installs the plugin, records how to start the daemon, stops every shared instance so open sessions move over at their next call, restarts the daemon and waits for it to answer, then states the end state it measured. An IDE that finds no daemon starts one itself, refusing a command file anyone else could have written. 402 Python, 488 TypeScript, 301 Kotlin. Two things caught while building: the unit tests were restarting the developer's own daemon — 0.4 s of tests had become 33 s — so the two machine-touching steps are injected now; and `Killer` was counting `os.kill(pid, 0)` liveness probes as kills. Phase 5 is the live sequence, which needs the button pressed. |
