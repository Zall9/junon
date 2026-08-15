# ADR-0017 — Workspace symbol search and unverified search handles

## Status

Accepted — 2026-08-02

## Context

`workspace/searchSymbols` is the first routed operation whose result spans many documents. Every
prior symbol route was scoped to one requested document, and both the handle model (ADR-0003,
ADR-0016) and the daemon's authority checks were built on that assumption.

Three properties of the operation break those assumptions.

The response schema reuses the shared `symbol` definition, so every hit must carry a handle. A
handle is bound to an adapter session, a workspace epoch, and — for document symbols — a bracketed
revision. A search cannot bracket a revision: the provider ran over its own snapshots of N
documents, so a revision captured afterwards would describe a buffer the provider never saw.
Opening every hit's document to hash it would load N buffers into the extension host and emit
`document/opened` and `document/closed` notifications, making a read operation externally
observable, in exchange for a hash that proves nothing about the provider's ranges.

The daemon's post-schema authority check (`#assertRoutedDocumentSymbols`) and its pre-schema bound
check were both gated on `document/getSymbols` and keyed on the single requested document URI. A
search request carries no `uri` parameter, so both checks were skipped entirely: nested handles
claiming another adapter, another session, or an arbitrary epoch, and locators outside every
registered root, would have been forwarded unvalidated.

The VS Code `WorkspaceSymbolProvider` contract explicitly permits `provideWorkspaceSymbols` to
return a partial `location` with no `range`, to be completed later by `resolveWorkspaceSymbol` —
which no public command exposes to an extension. IDEBP requires both `range` and
`locator.selectionRange`. Such entries are therefore not representable.

## Decision

### Handles carry no verified revision

- A search handle is bound to the adapter ID, the physical session ID, the workspace epoch, and its
  document URI. It carries no `editorVersion`.
- The adapter opens no document to serve a search. `document/opened` is never emitted as a side
  effect of a read.
- Search handles are invalidated by the same events as document handles: a change to their document,
  a workspace identity or epoch change, reconnection, and disposal.
- **A search handle is a fast path, not an authority.** Any operation that consumes one must
  re-resolve it through controlled locator relocation (ADR-0003) and fail closed with
  `STALE_SYMBOL` or `AMBIGUOUS_SYMBOL` rather than act on an unverified handle. Relocation is a
  blocking prerequisite of the symbol navigation increment, not an optional refinement.
- A file changed outside the editor while closed emits no VS Code event and therefore invalidates
  nothing. Relocation at point of use is what makes this safe; a filesystem watcher would narrow
  the window and is deferred with the rename/delete event increment.

### Separate handle namespaces

- Search results are materialized into their own bounded FIFO generations. They never replace a
  document's handle set: a search that happens to match a document already explored through
  `document/getSymbols` must not revoke handles that document already handed out.
- Capacity pressure evicts the oldest search generation first and never sacrifices document
  handles, so accumulated search history cannot fail a later request.

### Result composition

- Hits outside every registered root are filtered. This is a scope decision and does **not** set
  `truncated`.
- Hits the requested `kinds` filter excludes are dropped and do **not** set `truncated`.
- In-scope hits IDEBP cannot represent — notably a `location` without a `range` — are dropped and
  **do** set `truncated`, because the workspace holds matches the response does not carry.
- The `limit` is applied after scope and kind filtering, so filtering never silently shrinks a
  result below what the consumer asked for.
- An oversized response is shrunk and reported through `truncated` rather than failed: many matches
  is a normal outcome, not a provider failure.
- `SymbolInformation` exposes a single range, which backs both the declaration range and the
  locator selection range. No narrower identifier range is invented.
- `undefined` or `null` means no provider produced a result and returns `CAPABILITY_UNAVAILABLE`.
  An empty array is a successful empty result.

### Shared bounds

- `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT` (200) and `IDEBP_MAX_SYMBOL_SEARCH_LIMIT` (1000) live in the
  protocol package. The adapter caps its result at the effective limit and the daemon rejects any
  result exceeding it; a divergent default would cost an adapter its session.
- `isUriWithinWorkspaceRoot` moves to the protocol package for the same reason: an adapter whose
  containment rule is looser than the daemon's is closed as a policy violation.
- The request schema bounds `query` at 256 characters and `kinds` at 26 items. The daemon otherwise
  relays an unbounded query straight into a provider. This narrows a pre-release 0.1.0 schema; no
  previously valid request that any adapter could serve becomes invalid.

### Daemon validation

- The pre-schema bound check and the post-schema authority check both apply to
  `workspace/searchSymbols`.
- Every hit must be uniquely handled, owned by the routed adapter and its physical session, carry
  exactly the current workspace epoch, contain no children, and point inside a registered root. The
  count must not exceed the effective request limit.
- A violation returns `PROVIDER_FAILED` to the consumer and closes the adapter session with a policy
  violation. The invalid result is never forwarded.

### Readiness

- The VS Code adapter never emits `INDEX_NOT_READY`. VS Code exposes no public index-readiness
  signal, and reporting a simulated `indexing` state would be an approximation of a capability the
  adapter does not have. A search issued while language services are still warming legitimately
  returns fewer results.

## Consequences

- Consumers receive real workspace-wide provider results with session-bound handles, at no
  document-opening cost and with no observable side effects.
- Search handles are weaker than document-symbol handles. This is stated on the wire only through
  their absence of a revision, so the guarantee lives in this ADR and in the relocation requirement
  above.
- Symbol navigation cannot ship without relocation. That coupling is deliberate.
- Query semantics remain the IDE's: VS Code applies relaxed fuzzy matching, so `query` is not a
  prefix or substring contract. The protocol does not define match semantics.
- The behaviour of the built-in `vscode.executeWorkspaceSymbolProvider` command with respect to
  lazily-resolved symbols is not verifiable from the type definitions. Whether rangeless entries
  occur in practice — and how often `truncated` is therefore set — can only be established by the
  outstanding real extension-host run.

## Alternatives considered

### Open every hit's document to capture an exact revision

Rejected. It would load N buffers, emit open/close notifications for a read, and produce a hash of a
buffer the provider never observed. The apparent coherence would be revision theater.

### Drop unrepresentable hits silently

Rejected. The consumer would believe a result complete when the workspace holds matches it does not
contain.

### Fail the whole search when any entry is unrepresentable

Rejected. One lazily-resolving provider would break workspace search for every language in the
window.

### Reuse the document-symbol handle namespace

Rejected. A search would silently revoke handles a consumer already holds for that document.

### Bound `query` in the adapter instead of the schema

Rejected. The daemon would still relay an unbounded query, and each adapter would have to
re-implement the bound. Pre-dispatch schema validation is the layer that already protects both
peers.
