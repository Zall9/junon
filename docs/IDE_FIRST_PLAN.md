# The IDE first, wherever it can answer

**Status:** in progress — see the [update log](#update-log).

## Why

Asked on 2026-09-25: *"toujours commandes ide si dispo — par exemple find_symbol => ide_find_symbol
existe donc on doit utiliser lui."*

Measured from `opencode.db` over opencode 2's first three days (2026-09-22 16:29 onwards), every
serena call made through `execute`:

| Question | serena's language server | the IDE |
| --- | --- | --- |
| where a symbol is, one declaration | `find_symbol` 165 | `ide_find_symbol` 6, `ide_read_symbol` 16 |
| a file's outline | `get_symbols_overview` 23 | `ide_symbols_overview` 1 |
| who uses it | `find_referencing_symbols` 15 | `ide_hierarchy` 0 |
| the file itself | `read_file` 87 | `ide_read_document` 55 |

And the file-tool gate pushed that way itself: every refusal named `find_symbol` first.

## Decisions

| Decision | Why |
| --- | --- |
| Every refusal and every answer of both gates names the IDE tool first — `ide_find_symbol`, `ide_read_symbol`, `ide_hierarchy`, `ide_symbols_overview` — and serena's language-server tool only as what answers when no IDE has the project | What was asked, and the gate was teaching the opposite |
| Under opencode 2, a `grep` for a bare identifier inside the project is answered from the IDE's index — its declarations, and its callers when there is one callable — instead of refused; the same grep again runs | The next leak after whole reads: after a grep refusal, 10 of 16 agents went to another grep or a glob. An answer costs the agent nothing; a refusal costs a round-trip it spends elsewhere |
| When a file's declarations cover little of it, the outline says which lines they leave out | Seen on 2026-09-25: a 315-line Pest test file outlined as one function, `29-34 mockProducer`; its `it()` blocks are not declarations |
| `junon-usage.py` counts answers by the first line of the answer only | A `read` of a file that merely contains the marker sentence — this gate's own source — would have counted as an outline |
| Serena's own tools are **not** made to answer from the IDE | Examined and refused, see Phase 4 |

## Phases

### Phase 0 — measure

**Status:** done 2026-09-25 — the table above. Also measured: 138 of 170 `find_symbol` calls ask for
the body, and 36 of 157 calls to `find_symbol`, `get_symbols_overview` or `find_referencing_symbols`
process the answer in code (`JSON.parse(r.result)`, `r.map(s => s.name_path)`).

### Phase 1 — both gates advise the IDE first

**Status:** done 2026-09-25 — `withoutAnIde` / `without_an_ide` name serena's tools as the answer
without an IDE, after the IDE's, in all six refusals of each gate; a test asserts, per refusal, that
the first tool named is an `ide_*` one. Seen in the real opencode 1:
`serena_ide_find_symbol({ query: "entry7" })` first, `serena_find_symbol` on the line for a project no
IDE has open.

The real opencode 1 also showed a flaw of the last release that no test had: the strict refusals
counted towards the give-up, so a session that had been refused four whole reads — and then read
ranges, as told — had its bare-identifier nudge switched off. They no longer count, in either gate.

**Acceptance:** in every refusal of both gates, the first tool named is an `ide_*` one wherever one
answers the question; serena's equivalent follows, as the answer when no IDE has the project.

### Phase 2 — opencode 2 answers an identifier grep from the IDE's index

**Status:** done 2026-09-25 — `lookupProgram`. Seen in the real opencode 2, three ways: through the
machine's shared instance on `vod/core`, open in PhpStorm, `grep showChannel` came back as
`method showChannel — app/Services/LinkService.php:43`, callers none — and the real grep run next
found one match, the declaration; on a scratch project no IDE had, as serena's
`Method Ledger/entry7 — big.ts:38`; with no serena, as the refusal. The same grep repeated ran each
time. A name nothing declares (`REDIS_TEMPORARY_TOPICS`) came back as a short "text search — run it
again", not as advice to ask the index that had just answered.

Exact names only: the IDE searches the way Go to Symbol does, and a near miss offered for a config
key would answer a question nobody asked.

**Acceptance:** in the real opencode 2, a bare-identifier `grep` comes back with the declarations from
`ide_find_symbol` (and callers from `ide_hierarchy` for a single callable) through an IDE that has the
project, with serena's `find_symbol` without one, and as the refusal with no serena; repeated, it runs.

### Phase 3 — an outline says what it does not cover

**Status:** done 2026-09-25 — seen on the file that prompted it, `RpsBroadcasterTest.php` (441 lines
by then), through PhpStorm: *"These declarations cover 6 of 441 lines. Outside every one of them:
1-28, 35-441"*.

**Acceptance:** an outline whose declarations cover less than half of the file lists the line ranges
outside every declaration.

### Phase 4 — serena's tools answered by the IDE

**Status:** not done — examined and found unsound as proposed; an alternative is put to the user.

Proposed on 2026-09-25: make `find_symbol`, `get_symbols_overview`, `find_referencing_symbols` and
`read_file` answer from the IDE when it has the project open. Three findings against it:

- **Agents program against serena's answers.** 36 of 157 calls process the result in code, by its
  fields. An IDE answer in another shape breaks those programs; rebuilding serena's exact shape from
  the IDE — its `name_path`, its kind names — would be an approximation, which AGENTS.md §1 forbids.
- **`read_file` must read the disk.** Serena's line-based edit tools and opencode's `edit` write to
  the disk; serving the IDE's buffer would show line numbers that do not match it whenever an edit is
  unsaved.
- **It reverses a recorded decision.** `junon/tools.py`: JUNON's tools are additive, and replacing one
  of Serena's is done through `excluded_tools`, in a configuration a user can read.

## Update log

| When | What |
| --- | --- |
| 2026-09-25 | Phases 1–3 done, proved in both real opencodes and through PhpStorm. |
| 2026-09-25 | Plan written, Phase 0 measured, Phase 4 examined. |
