# The gate follows JUNON, and the dashboard says what changed

**Status:** done — released in 0.3.11; see the [update log](#update-log).

## Why

Since 0.3.10 the file-tool gate is installed by `scripts/update-all.sh` and by the dashboard's install
button. It is not installed by any other way JUNON gets updated:

| JUNON updated by | Gate follows? |
| --- | --- |
| `update-all.sh`, the install button | yes |
| `git pull` alone — the usual case, since JUNON is an editable install that reads the checkout | **no** |
| `pipx upgrade` of a non-editable install | **no** — the installer exists only in a checkout |
| the IDE's plugin updater | **no** |

And nothing says whether the installed gate is the running JUNON's: not `doctor`, not the dashboard.
Separately, a release is only readable in `CHANGELOG.md`; the dashboard, which is where an update is
offered, says nothing about what it contains.

## Decisions

| Decision | Why |
| --- | --- |
| **One implementation**, in Python (`junon/agent_gates.py`), reading one manifest (`integrations/agent-hosts/manifest.json`) | The shell script, the click and the self-update must not become three installers. `install-agent-gate.sh` stays the documented command and becomes a wrapper; `doctor` (TypeScript) reads the same manifest |
| The gate refreshes itself when a `junon serve` instance starts | An instance is what every update route ends in, whichever it was. Not the relay: a host opens twenty-three at once, and a relay must stay cheap |
| In the background, under a lock, written atomically, the old copy kept | Instances start together; a start must not wait on it; a half-written plugin would be loaded by opencode as is |
| `JUNON_AGENT_GATE_AUTO=0` turns it off | JUNON writing into `~/.config/opencode` unasked is a decision the user took, and is one they can undo |
| The gate and `CHANGELOG.md` travel inside the package | A non-editable install has no checkout. Linked into `junon/resources`, which is already packaged |
| The changelog tab shows the last three released versions, then links to the repository's `CHANGELOG.md` | What was asked. Rendered server-side from the file that ships with the running code, so the page describes what is installed |

## Phases

### Phase 0 — one implementation

**Status:** done 2026-09-23 — `junon/agent_gates.py`, `integrations/agent-hosts/manifest.json`

`install-agent-gate.sh` is now a three-line wrapper; `update_action.install_agent_gates()` calls the
module directly instead of running the script and parsing its output. The 22 existing gate tests
passed unchanged through the new module, and `--check` on the machine reports every file current.

**Acceptance:** `install-agent-gate.sh`, `update_action.install_agent_gates()` and the self-update all
go through `agent_gates`; every existing gate test passes unchanged.

### Phase 1 — the gate and the changelog inside the package

**Status:** done 2026-09-23 — `junon/resources/agent-hosts` and `junon/resources/CHANGELOG.md` are
relative links into the repository, so a wheel carries the files and there is no second copy.

`test_packaging.py` builds a real wheel, finds every gate file, the manifest and the changelog in it,
and loads `agent_gates` from the unpacked wheel to prove it finds the packaged copy with no checkout.
Two things found on the way. setuptools reuses `build/` and never removes a file from it, so the
fixture now clears it — an exclusion added to `pyproject.toml` was otherwise invisible. And
`exclude-package-data` was not honoured for the gate's test and vitest config, which therefore ship;
harmless, since only what the manifest lists is ever installed, and said so in `pyproject.toml`
rather than left as a declaration that does nothing.

**Acceptance:** a wheel built from the repository contains the gate files and `CHANGELOG.md`, and
`agent_gates` finds them when there is no checkout.

### Phase 2 — the gate refreshes itself

**Status:** done 2026-09-23 — `serve.run()` calls `agent_gates.refresh_on_start()`.

Acceptance met by a real `junon serve` process started against a home holding an older gate: the gate
is current within seconds, the old copy kept. Eight installs racing write it once, under the lock.
`JUNON_AGENT_GATE_AUTO=0` leaves it alone.

**Acceptance:** a real `junon serve`, started against a home holding an older gate, replaces it and
keeps the old copy; two started together write it once; the opt-out leaves it alone.

### Phase 3 — visible in `doctor` and on the dashboard

**Status:** done 2026-09-23

`ide-bridge doctor` reports `agent-gates` second, in every report, from the same manifest: on this
machine `pass, current`. The dashboard's `/junon/ide-bridge/status` carries `agentGates`, and the card
draws it — seen in the real dashboard as "Agent gate: The agent gates are this release's (Claude Code,
measurement, opencode)". The out-of-date branch was exercised in the live page with a fabricated
status rather than by breaking the machine's gate, and the server text in it came out escaped.

One gap in the verification itself, closed: vitest does not type-check, so a TS4111 error in the new
check passed the TypeScript suite and failed only `tsc`. `pnpm typecheck` is now part of the run.

**Acceptance:** `ide-bridge doctor` has an `agent-gates` check; the IDE Bridge card has a line for the
gate, shown when current as well as when not.

### Phase 4 — the changelog tab

**Status:** done 2026-09-23 — `junon/changelog.py`, `/junon/changelog`, a third tab.

Seen in the real dashboard: 0.3.10 marked *installed*, 0.3.9, 0.3.8, then "Every release, in
CHANGELOG.md on GitHub →"; no script element anywhere in the rendered notes. The page's polling is
unchanged for the other tabs, and the changelog is fetched once per visit to its tab.

**Acceptance:** seen in the real dashboard: three versions, the repository link below them, and the
page's text escaped rather than trusted.

### Phase 5 — release

**Status:** done 2026-09-23 — 0.3.11 released (`d96de4a`, `2cbeb8d`).

460 Python, 509 TypeScript and 301 Kotlin tests passed; `typecheck` and `lint` report only the
unused `version` in `scripts/make-update-repository.ts`, which predates this work. After
`update-all.sh` the machine answers from 0.3.11: `doctor` reports `agent-gates: pass, current`,
`install-agent-gate.sh --check` exits 0, and a private instance started from the installed `junon`
shows 0.3.11 marked *installed*, then 0.3.10 and 0.3.9 and the link to GitHub, with the gate line
on the IDE Bridge card. The machine's gate was byte-identical before and after (the probe ran with
the refresh off), and no backup was added. PhpStorm stayed on the 0.3.10 plugin because it was
open; `doctor` names it, as it should.

**Acceptance:** three suites green, 0.3.11 pushed, and the machine checked after the update.

## Update log

| When | What |
| --- | --- |
| 2026-09-23 | Phase 5 done: 0.3.11 released and checked on the machine — `doctor` pass, `--check` 0, the Changelog tab and the gate line seen in a private instance of the installed `junon`. |
| 2026-09-23 | Phases 0–4 done. Mutations on copies, controls green first: eight on the Python side (the instance refresh, the lock, the kept copy, the opt-out, escaping, three versions, Unreleased, the card's line) and three on `doctor`, all red. The machine's gate untouched throughout, checked by hash. |
| 2026-09-23 | Plan written. |
