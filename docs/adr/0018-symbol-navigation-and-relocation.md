# ADR-0018 — Symbol navigation and controlled relocation

## Status

Accepted — 2026-08-02

Amends ADR-0003 (relocation matching rule). ADR-0003 otherwise remains in force.

## Context

ADR-0017 shipped `workspace/searchSymbols` with handles that carry no verified revision, and made
controlled relocation a blocking prerequisite of this increment: a handle is a fast path, and any
operation consuming one must re-resolve it and fail closed rather than act on an unverified
pointer. This increment adds the operations that consume handles — `symbol/resolveAt`,
`symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations` — and the relocation
they depend on.

Three problems had to be resolved.

ADR-0003 specifies relocation as "use the locator's `fingerprint` to match against current
symbols", and separately claims relocation "provides resilience against minor document changes".
Those two statements are incompatible with the implemented fingerprint, which hashes the selection
range along with the identity fields. Any symbol shifted by one line gets a different fingerprint,
so fingerprint matching fails in exactly the situation where a handle has gone stale and relocation
is needed. Literal fingerprint matching would deliver a feature with almost no value.

The daemon's routed-result authority checks covered `document/read`, `document/getRevision`,
`document/getSymbols`, and `workspace/searchSymbols`. The four new methods return handles
(`symbol/resolveAt`) and URIs (all three lookups) that would have been forwarded to consumers
without any ownership, epoch, or containment validation — the same class of gap ADR-0017 closed for
search, on a new method family.

The handle registry distinguishes document handles, replaced atomically per document, from search
handles in FIFO generations. `symbol/resolveAt` produces a single symbol for a document that may
already have a full symbol tree registered. Minting it through the document namespace would replace
that tree's handles and silently revoke handles a consumer already holds.

## Decision

### Relocation matches semantic identity, not the fingerprint

- Relocation matches on the locator's `documentUri`, `name`, `kind`, and `containerName` — all of
  which travel on the wire in clear. The selection range is used **only** to break a tie between
  otherwise indistinguishable candidates.
- `containerName` is compared as optional on both sides: a locator minted from a flat search result
  legitimately lacks the container a hierarchical document provider reports, and that absence must
  not prevent relocation.
- Exactly one match returns a fresh handle. Zero matches return `STALE_SYMBOL`. Several
  indistinguishable matches return `AMBIGUOUS_SYMBOL` carrying every candidate locator, capped at
  32. Relocation never picks one arbitrarily.
- Relocation never crosses documents. A locator identifies a symbol inside its own document only.
- **This amends ADR-0003.** The fingerprint remains exactly what it was on the wire — an exact
  identity including position — and is still what distinguishes overloads within one result. It is
  simply not the relocation key.

### Reference resolution order

- A live handle is the fast path: owned by this adapter, this physical session, and the current
  epoch, and still present in the registry.
- Otherwise the locator is used for relocation. A handle that no longer resolves **and** no locator
  leaves nothing identifying the symbol, so the only truthful answer is `STALE_SYMBOL`.
- A locator pointing outside every registered root returns `PERMISSION_DENIED` before any document
  is opened.

### Point resolution is transient

- `symbol/resolveAt` mints its handle in the non-replacing transient namespace, alongside search
  hits, so it never revokes a document's existing handles. The namespace is a bounded FIFO evicted
  oldest-first and never at the expense of document handles.
- Unlike a search hit, a point resolution *does* carry a bracketed revision: the document is read
  before and after the provider call and the result is discarded with `STALE_DOCUMENT` if the
  revision moved (ADR-0016). Its record therefore retains an `editorVersion`.

### Position encoding

- The adapter registers `positionEncodings: ["utf-16"]`. A `symbol/resolveAt` request declaring
  `utf-8` or `utf-32` is refused with `INVALID_REQUEST` before any provider runs. Reinterpreting the
  offsets would silently select a different character.

### `symbol/resolveAt` may resolve to no symbol

- A position covered by no symbol — a blank line, a comment — is an ordinary outcome, not an error.
  `symbol` is therefore **optional** in the `symbol/resolveAt` result: the response carries the
  document reference and omits the symbol.
- This narrows nothing and invents no error code. The alternative considered and rejected was
  answering `PRECONDITION_FAILED`, the least-wrong code in a catalogue that has no
  `SYMBOL_NOT_FOUND` — reporting a normal query as a failed precondition would misdescribe it.
- No handle is minted for an empty resolution. The daemon validates the symbol only when present.

### Location results

- Lookups return `locations` and a required `truncated` flag. `symbolLocation.symbol` is optional in
  the schema and the VS Code adapter omits it: minting a handle per reference would be expensive and
  would inherit the unverified-revision problem across every referencing document.
- `truncated` reports the fixed ceiling only. These requests carry no `limit`, so without the flag a
  symbol with 5,000 references would silently return 1,000 and read as a complete answer. Root
  filtering does **not** set it, matching the ADR-0017 rule that scope decisions are not
  incompleteness.
- The ceiling is applied after filtering, so out-of-scope entries never displace in-scope ones, and
  the scan itself is bounded independently so a provider returning mostly out-of-scope results
  cannot make the loop unbounded.
- `Location` and `LocationLink` provider shapes are both mapped. For a `LocationLink` the
  `targetSelectionRange` is preferred over `targetRange` when present, since it is the identifier
  span.
- Locations outside every registered root are filtered. The daemon enforces the same containment.
- Results are capped at the shared `IDEBP_MAX_SYMBOL_LOCATIONS` (1000), fixed in the protocol
  package: the adapter truncates at it and the daemon rejects any result exceeding it.

### Daemon validation

- The pre-schema bound check now also covers `symbol/resolveAt` (single `result.symbol`) and the
  three lookup methods (`result.locations` length).
- `symbol/resolveAt` results are validated like a document-symbol result: the document must belong
  to the workspace and be exactly the requested URI, and the symbol's handle must carry the routed
  adapter, the routed physical session, and exactly the current epoch.
- Lookup results are validated per location: every URI must lie inside a registered root, and any
  optional embedded symbol must additionally be uniquely handled and owned by the routed session at
  the current epoch.
- A violation returns `PROVIDER_FAILED` to the consumer and closes the adapter session with a policy
  violation.

## Consequences

- Relocation now survives the edits that motivate it. A symbol moved down five lines by an unrelated
  insertion still resolves.
- Overloads that a locator cannot disambiguate produce `AMBIGUOUS_SYMBOL` with candidates rather
  than a silent wrong-symbol operation — the behaviour ADR-0003 required.
- Every handle-consuming operation now fails closed, satisfying the ADR-0017 precondition. Search
  handles are safe to use because they are re-resolved, never trusted.
- Consumers cannot see references located outside the workspace. For the common case — references to
  a workspace symbol — those are rare; the trade is deliberate and stated.

## Host limitation without a remedy

**Provider absence is not observable for lookups.** ADR-0016's rule is applied (`undefined`/`null` →
`CAPABILITY_UNAVAILABLE`, `[]` → successful empty result), but VS Code's `executeReferenceProvider`
and its siblings return `[]` whether or not a provider is registered, and the extension API exposes
no provider registry to consult. An empty result may therefore mean "no references" or "no
provider", and the adapter cannot tell.

This is not a gap the adapter can close: no public API distinguishes the two, and guessing — for
example inferring absence from the document's language — would be an approximation presented as
truth, which AGENTS.md §1 forbids. The capability declaration means what ADR-0016 established: the
route is implemented. If a future VS Code release exposes provider registration, this becomes
answerable; until then it is stated rather than hidden.

## Alternatives considered

### Match relocation on the fingerprint, as ADR-0003 literally says

Rejected. It fails for any symbol that moved, which is the case relocation exists to handle. Kept as
an explicit amendment rather than an undocumented deviation.

### Try the fingerprint first, then fall back to semantic fields

Rejected. Two success semantics inside one operation, harder to specify and test, and identical in
outcome to semantic matching wherever it succeeds.

### Mint a handle for every returned location

Rejected. Expensive, and it would spread the unverified-revision problem across every referencing
document for no gain — the schema makes the field optional precisely because navigation results are
positions, not durable symbol identities.

### Mint the `resolveAt` handle in the document namespace

Rejected. It would replace and revoke the handles a prior `document/getSymbols` handed out for the
same document.

### Answer `PRECONDITION_FAILED` when no symbol covers the position

Rejected. It reports an ordinary query as a failure because the catalogue happens to lack an
accurate code. Making `symbol` optional describes the outcome truthfully instead.

### Filter locations silently, with no `truncated` flag

Rejected for the ceiling. A capped result is indistinguishable from a complete one, so a symbol with
thousands of references would read as having exactly a thousand. Root filtering keeps no flag, since
that is scope rather than incompleteness.
