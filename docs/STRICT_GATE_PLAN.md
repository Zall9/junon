# A gate agents cannot walk around, and reads JUNON answers itself

**Status:** done — released in 0.3.12; see the [update log](#update-log). What is left is measuring
it in real sessions once opencode has restarted: `junon-usage.py --days 2`, its `outlined` column.

## Why

Asked on 2026-09-24: *"j'ai encore mes sub agents et agents qui utilisent des read etc — y'a pas moyen
de rendre la gate plus stricte ou de faire en sorte de remplacer les read par […] serena ?"*

Measured from `opencode.db` over the 21 hours since the 0.3.10 gate was installed, opencode 2 only
(opencode 1 has written nothing since 2026-09-22 15:51):

| What happened right after a refusal | Times |
| --- | --- |
| another file tool — mostly `sed -n`, `cat`, `head` through the shell | 67 |
| serena | 28 |
| a different `read` | 22 |
| the same call again, which the gate then lets through | 18 |
| a `read` with a range | 7 |

- 121 whole-file reads of source ran anyway.
- 10 of 30 sessions never called serena, and 8 of those 10 were sessions where the gate **gave up**:
  after three ignored refusals it stops for a session that has never used a symbolic tool. It was
  meant for agents with no serena at all; every agent in the active preset has it.
- Every range an agent passed was ≤ 300 lines: ranges are used for what they are, not as a way
  around.

## Decisions

| Decision | Why |
| --- | --- |
| A whole read of a source file of 300 lines or more is **never** let through on the second try | Retrying was the cheapest way around. The way out is a range (`offset`/`limit`), which every agent has, so nothing becomes unreachable and no agent can loop |
| That rule does not give up on a session | The give-up protected agents without serena. A range is not serena, so there is no one left to protect |
| Under opencode 2 that read is **answered with the file's outline** — the IDE's, else serena's — instead of refused | What was asked for: the read is replaced, not bounced. opencode 2 lets a hook rewrite a call; the outline comes back as the read's own result, with the line of every declaration so the next read can be a range |
| opencode 1 and Claude Code refuse it, every time | Neither lets a hook change which tool runs. Their refusal says how to read a range |
| `cat`, `bat`, `less`, `more` and `nl` of such a file are the same read | 67 of the refusals were followed by the shell. `sed -n`, `head` and `tail` are ranges and pass |
| Only files **inside the session's project** | JUNON cannot answer about a file outside it; refusing one is a refusal with nothing behind it |
| grep, short files and the per-session budget keep their once-then-through nudges | They are guesses about intent. The large-file rule is not |

Measured before deciding, in the real opencode 2 with a scripted model: the rewritten `read` returns
the `execute` result to the model; a real JUNON behind it answered with the outline; with no serena
the fallback text came back instead of an error; `edit` needs no prior `read` there, so an outline
in place of the read cannot block an edit.

## Phases

### Phase 0 — measure

**Status:** done 2026-09-24 — the numbers above; scripts in the session scratchpad, not the repository.

### Phase 1 — the opencode gate is strict

**Status:** done 2026-09-24

In the real opencode 1.18.31 and 2.0.12, isolated, with a scripted model: a whole read of a 307-line
file refused twice in a row, a range read, `cat` refused twice, `sed -n` run. Under opencode 1 an
`edit` after the ranged read succeeded — opencode 1 wants a read before an edit, and a range counts.

Three refusals with nothing behind them turned up while doing it, and were fixed with it: a file
outside the project (the gate refused a read of this session's own scratch files); a quoted regex
alternation, `grep -E "tool|error" x.log`, split on the `|` into `grep "tool`, a bare identifier; and
a `grep` fed by a pipe, which filters output rather than searching files.

**Acceptance:** under both hosts, a whole read of a large source file inside the project is refused
on the second and the tenth attempt, a range passes, a file outside the project passes, and `cat` of
it is refused the same way; a session that ignored three refusals is still refused.

### Phase 2 — opencode 2 answers the read with the outline

**Status:** done 2026-09-24

Seen in the real opencode 2, three ways: through the machine's own JUNON instance on `vod/core`, which
PhpStorm had open, the read of `app/Services/LinkService.php` (774 lines) came back as the IDE's
outline — `32-774 class LinkService`, `43-51 method showChannel`, lines matching the file; through a
private JUNON on a scratch project no IDE had open, as serena's language-server outline; and with no
serena, as the refusal, as the read's result rather than an error. `vod/core`'s working tree was
identical before and after.

Measured on the way, and designed around rather than guessed at: the catalog `execute` is given is
fixed for the turn — serena can be missing from a session's first turn while `ctx.mcp.list()` reports
it connected — and the sandbox has no `setTimeout`, so that turn gets the refusal and the next the
outline. `search` is synchronous. The database records the `read` the model made, holding the
outline, so `junon-usage.py` tells them apart by their text; checked on a database the real host wrote.

**Acceptance:** in the real opencode 2, a whole read of a large file returns an outline with line
numbers from a real JUNON, and the refusal text when serena is unreachable; `junon-usage.py` counts
outlines apart from the agents' own serena calls.

### Phase 3 — Claude Code

**Status:** done 2026-09-24 — `integrations/serena/tests/test_claude_code_gate.py`, 15 tests, running
the hook as Claude Code does: a process per call, JSON on stdin, its memory in a directory the test
owns (`JUNON_GATE_MARKERS`) rather than the `/tmp` the session running the suite uses.

**Acceptance:** the Claude Code gate applies the same rules, its advice names `relative_path` with a
project-relative path, and it has behaviour tests of its own — it has had none.

### Phase 4 — release

**Status:** done 2026-09-24 — 0.3.12 (`699ba4e`, `1d99a3d`).

524 TypeScript, 475 Python and 301 Kotlin on 0.3.12; `typecheck`, `lint` and `format:check` report
only what predates this work. After `update-all.sh` the machine's gates are this release's — each
previous copy kept — and `doctor` reports `agent-gates: pass, current`. In the Claude Code session
that built it, the installed hook refused a whole read of a 1172-line file twice, let the range
through, and let `grep -E "tool|error"` through on the first try — the command it had refused that
morning. opencode reads its plugin at start-up, so the outline reaches the user's sessions when the
opencode service restarts; the installed file is byte-identical to the one proved in both real hosts.

The Kotlin run re-records `packages/conformance/captures/jetbrains.json` with fresh random ids every
time; that was restored rather than committed with the release.

**Acceptance:** three suites green, 0.3.12 pushed, and the machine checked after the update.

## Update log

| When | What |
| --- | --- |
| 2026-09-24 | Phase 4 done: 0.3.12 released, installed, and seen refusing in the real Claude Code; `doctor` pass. |
| 2026-09-24 | Phases 1–3 done. 524 TypeScript, 475 Python, 301 Kotlin (run fresh). Fifteen mutations on copies — nine on the opencode gate, five on the Claude Code gate, one on the usage report — controls green first, all red — one missed at first (the give-up re-applied to `cat` went unseen: the test covered `read` only), the test extended and the mutation re-run. |
| 2026-09-24 | Plan written, Phase 0 measured. |
