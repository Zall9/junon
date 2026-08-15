# ADR-0031 — Search results are judged by the shared rules

## Status

Accepted — 2026-08-09

## Context

`workspace/searchSymbols` (ADR-0017) was the only symbol route the conformance suite never judged.
Measured 2026-08-09: `checkDocumentSymbols`, `checkSymbolLocations`, `checkDiagnostics`,
`checkEditPlan`, `checkModification` and `checkWorkspace` all exist, and nothing covered search —
neither its own rule set nor an entry in either adapter's capture.

That absence was not theoretical. ADR-0030 records the JetBrains adapter dropping a declaration from
every search result while answering `truncated: false` — an omission presented as a complete result,
through two independent gates, for as long as the route has existed. Nothing outside the adapter's own
tests ever looked at the shape it returned, so nothing could have said so.

The daemon does validate routed search results (ADR-0017, "Daemon validation"), and that validation is
real: a violation closes the session. But it is one peer enforcing authority at run time — ownership,
epoch, containment, count — not a contract two adapters are held to, and it says nothing about a
symbol's geometry. ADR-0025 already settled where a cross-IDE rule belongs: in one implementation, with
the responses travelling to it.

## Decision

### One rule set, `checkSearchSymbols`

A search hit is a symbol like any other, so its handle binding and its geometry are judged exactly as a
document's symbols are — **reusing those rule names deliberately**, because a range that runs backwards
is the same defect wherever it appears:

- `handle.bound-to-adapter`, `handle.bound-to-session`, `handle.bound-to-epoch`,
  `handle.unique-in-response` — ADR-0017's daemon validation, restated as a contract rather than left
  as one peer's guard.
- `locator.within-a-root`, `locator.named`.
- `range.well-formed`, `selection-range.well-formed`, `selection-range.within-declaration`. This is
  what brings ADR-0030's **empty** selection range under the shared rules on this route too, rather
  than only on `document/getSymbols`.

Two rules are the route's own, because a search spans documents rather than describing one:

- `search.hits-are-flat` — the result is flat by decision (ADR-0017), so nesting would be a shape no
  consumer is prepared to walk.
- `search.within-requested-limit` — a result larger than the ceiling the request carried is not a
  truncated answer but an unbounded one. The capture records the **request's own** limit, not
  `IDEBP_MAX_SYMBOL_SEARCH_LIMIT`; judging against the protocol maximum would have made the rule almost
  unfalsifiable.

### What is deliberately not a rule

- **`truncated` with an empty list is legitimate here.** For lookups, `checkSymbolLocations` treats it
  as the one combination that cannot be true — a cap claimed on a list never filled. A search can
  genuinely reach a ceiling before matching anything: the JetBrains adapter stops after
  `MAX_SCANNED_NAMES` names, and ADR-0017 *requires* an in-scope hit it cannot represent to be reported
  through `truncated` rather than to vanish. Importing the lookup rule would have turned an honest
  answer into a violation.
- **Which hits came back.** ADR-0017 states the protocol defines no match semantics — VS Code applies
  fuzzy matching, the JetBrains adapter substring — so nothing here judges the membership of the
  result, only the shape of what is in it.

### The JetBrains part is required; the VS Code part is pre-wired

The JetBrains end-to-end run records a real search response, so its check is required and fails if the
capture predates the rule set. No extension-host scenario records a search yet, so the VS Code check
returns early when that part is absent — the same way the hierarchy check waited for its capture. A
mandatory check for a part no run produces would report a missing scenario as an adapter defect.

## Consequences

- The last symbol route without a shared rule has one. The gap ADR-0030 recorded is closed for
  JetBrains and needs only a recording run for VS Code.
- Each rule was verified by mutating the recorded capture and confirming that exactly its own rule
  fires: a child added to a hit raises `search.hits-are-flat`; a limit below the result size raises
  `search.within-requested-limit`; an altered epoch or adapter id raises its handle rule; a selection
  moved outside its declaration raises `selection-range.within-declaration`; a URI outside every root
  raises `locator.within-a-root`; a backwards range raises `range.well-formed`; a blank name raises
  `locator.named`. The real capture raises nothing, and an empty-but-truncated result stays legal.
- **Cross-adapter parity is not claimed for this route yet.** One adapter's real answers are judged by
  these rules; the other's will be when its scenario records one. That is stated here rather than
  implied by the presence of a check.
- A capture is still only as fresh as the run that wrote it — the limit `captured-adapters.test.ts`
  already documents, unchanged by this ADR.

## Alternatives considered

### Judge search with `checkDocumentSymbols`

Rejected. It requires a `document` and enforces `document.matches-request` and `locator.same-document`,
none of which a result spanning many documents has. Bending the subject to fit would have meant passing
a document the response does not describe, making two rules vacuous to reuse the rest.

### Judge search with `checkSymbolLocations`

Rejected on a measured incompatibility rather than on taste: its `truncation.implies-results` rule is
false for search, for the reason recorded above. A search hit is also a `symbol` carrying a handle and a
declaration range, not a `location`.

### Leave it to the daemon

Rejected. The daemon's validation is enforcement, not a contract: it acts on one peer's results at run
time, checks authority rather than geometry, and lives in the daemon's own implementation — which is
precisely the arrangement ADR-0025 rejected for cross-IDE rules.

### Require the VS Code check now

Rejected. It would fail against a capture no scenario writes, reporting a missing test scenario as an
adapter defect and pushing whoever hit it to satisfy the suite rather than to record the run.
