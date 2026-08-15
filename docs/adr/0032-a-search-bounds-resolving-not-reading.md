# ADR-0032 — A search bounds resolving, not reading, and says what it left out

## Status

Accepted — 2026-08-10

## Context

`workspace/searchSymbols` reads the IDE's own "Go to Symbol" index: for each
`ChooseByNameContributor`, it walks `getNames(project, includeNonProjectItems = false)`, keeps the names
containing the query, and resolves those through `getItemsByName`. ADR-0017 bounds the work with
`MAX_SCANNED_NAMES = 20_000` on the stated ground that "stopping early and saying so beats an answer
that arrives after the consumer has given up waiting".

The bound was on the wrong half. Measured against a running sandbox IDE on 2026-08-10, driving the real
daemon from a consumer:

- Every query — `Companion`, `PlatformSymbolKindMapper`, `EQUIVALENT_PHRASES`, `kindOf`,
  `BY_PLATFORM` — returned **zero hits with `truncated: true`**, including names whose declarations the
  same session returned happily through `document/getSymbols`.
- `truncated: true` can only come from the scan ceiling, so the budget was spent before the scan reached
  the project's own names. It was spent on **library** names: the contributors return the JDK's and
  Kotlin's own names even when asked for project items only (measured that morning —
  `KotlinGotoClassContributor` listing `Int`, `Array`, `AtomicBoolean`…).
- Worse, the loop's `if (!exhausted) break` abandoned every remaining contributor once one had run
  long, so a single large contributor starved every other language in the IDE.

A fixture project is too small to ever reach the ceiling, which is why 213 passing tests said nothing
about it. Only a real IDE could.

Separately, and found while diagnosing the above: the search route dropped hits it could not represent
**in silence**. ADR-0017 exempts scope filtering from `truncated` and nothing else — an in-scope hit
IDEBP cannot represent must be reported — yet a missing file URL, a missing text range, an anchor
outside its declaration, or offsets a `LineIndex` does not cover all vanished with the flag left alone.

## Decision

### The budget counts resolutions

- `MAX_RESOLVED_NAMES` (20 000) bounds calls to `getItemsByName` — the half that reads the index and
  builds PSI. Reading a name and testing it against the query touches strings the platform already
  holds, and is no longer counted.
- `truncated` therefore changes meaning, deliberately: from "I stopped reading names" to "there were
  more matches than I would resolve". The first was true and useless; the second is what a consumer can
  act on.
- The cross-contributor `break` stays, but now fires only when the resolve budget is spent — a state in
  which nothing more *can* be resolved. It no longer stops other languages for a reason unrelated to
  cost.
- ADR-0017's guarantee is unchanged in substance: the work is still bounded and the ceiling is still
  reported. It is the accounting that was wrong, not the promise.

### An unrepresentable hit is reported, not dropped

The route now sets `truncated` when it discards a hit for a representability reason: no file URL, no
text range, no usable identifier anchor (ADR-0030), offsets outside the document, or no name. Scope
filtering — a hit outside every registered root — continues **not** to set it, exactly as ADR-0017
says: scope is a decision about what was asked for, not an admission of something withheld.

## Consequences

- Verified live, twice over. First, the starvation: the same five queries that had answered nothing came
  back in 9–62 ms with `truncated: false`. Then, once the sandbox project was given a source root and
  indexed, the positive case: `Companion` over the plugin's own source returned **16 hits in 48 ms with
  `truncated: false`**, where the identical query had returned zero with `truncated: true` an hour
  earlier. An empty index and a starved scan look the same from outside, which is why both halves had to
  be shown.
- A search now costs a full pass over the contributors' name lists. That is string work over data the
  platform already materialised, and it is what the IDE's own Go-to-Symbol does; the expensive half
  stays bounded.
- The defect finally has a test. `test a flood of unmatched names does not starve the project's own`
  masks the contributors with one that returns 20 010 names no query will match followed by one that
  matches, and asserts the match is found with `truncated: false`. Restoring the old accounting fails
  exactly that test and no other; `test the budget still bounds the work, and says so` keeps the ceiling
  honest by making every name match.
- A consumer may now see `truncated: true` on searches that previously looked complete. That is the
  point: those answers were already partial.
- One measured limit, recorded rather than fixed: a project whose Gradle import produced no modules has
  nothing in the symbol index at all — not even library names — so a search over it returns zero hits
  with `truncated: false`. That is truthful (nothing was skipped) and it is the IDE's own state, not the
  adapter's; the IDE's own Go-to-Symbol dialog finds nothing there either.

## Alternatives considered

### Raise `MAX_SCANNED_NAMES`

Rejected. It makes the failure rarer without changing its shape: a large enough project starves the
same way, and the number that stops being wrong on one machine is wrong on the next.

### Bound per contributor instead of globally

Rejected as insufficient on its own — it fixes the starvation between contributors but still spends a
per-contributor budget on names that cost nothing to skip. Counting resolutions subsumes it: a
contributor whose names never match no longer consumes any budget at all.

### Push the filtering into the index (`ChooseByNameContributorEx.processNames` with a scope)

The most efficient answer, and left open. Rejected for now because it changes which API every language
plugin must implement for this route to work — `ChooseByNameContributorEx` is not what every
contributor is — and the measured problem is solved without narrowing the set of languages served,
which is the adapter's founding promise.
