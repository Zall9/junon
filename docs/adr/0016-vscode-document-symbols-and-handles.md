# ADR-0016 — VS Code document symbols and session-bound handles

## Status

Accepted — 2026-08-02

## Context

`document/getSymbols` is the first semantic/provider route in the VS Code adapter. VS Code can
return either hierarchical `DocumentSymbol[]` or flat `SymbolInformation[]`, and it does not expose
a public registry that lets an extension enumerate document-symbol providers by language. The
adapter must therefore represent provider availability truthfully without inventing a parser or a
textual fallback.

Every returned IDEBP symbol also carries an opaque handle. A handle is valid only for the physical
authenticated adapter session that created it, the current workspace epoch, and an unchanged
document. The reconnecting client previously exposed the session through the connection snapshot
but not through inbound handler context, so a handler could not safely mint a session-bound handle.

Provider results are untrusted DTO input. Schema validity alone does not prove that nested symbol
handles and locators belong to the routed adapter, session, workspace, epoch, or requested
document. Deep or oversized trees must also be rejected before recursive schema validation can
consume unbounded stack or CPU.

## Decision

### Provider invocation and capability

- The adapter advertises `document/getSymbols` as `support: "provider"` with
  `guarantee: "semantic"` only after its routed handler is attached.
- The only command invoked is the fixed VS Code API command
  `vscode.executeDocumentSymbolProvider`. No protocol parameter can select or construct a command.
- `undefined` or `null` means that no provider result exists for the requested document and returns
  `CAPABILITY_UNAVAILABLE`. An empty array is a successful result containing no symbols.
- Provider exceptions and malformed results return payload-free `PROVIDER_FAILED`. There is no
  regex, syntax guess, source scan, or text-edit fallback.
- The provider timeout and cancellation boundary remains owned by the shared bridge client. The
  command itself is not falsely described as cancellable; late completions are ignored after the
  inbound request settles.

### Revision coherence

- The adapter captures the exact in-memory document reference before invoking the provider and
  captures it again after the provider completes.
- Editor version, content hash, and workspace epoch must all remain equal. Otherwise the adapter
  returns canonical `STALE_DOCUMENT` with the current revision.
- Handles are materialized only after this comparison. A VS Code change event invalidates existing
  handles synchronously before its network notification is debounced.

### Symbol mapping and bounds

- All 26 VS Code `SymbolKind` numeric values map exactly to the corresponding IDEBP enum.
- Hierarchical `DocumentSymbol` results preserve their tree. Child locators receive the actual
  parent name as `containerName`.
- Flat `SymbolInformation` results remain flat and preserve a non-empty provider-supplied
  `containerName`. Their locations must use the exact requested URI.
- Declaration and selection ranges use UTF-16 positions. A selection range must be contained by
  its declaration range. Unsupported kinds, malformed ranges, blank/oversized names, mixed result
  forms, object cycles, and foreign URIs fail closed.
- The adapter does not invent `qualifiedName`. The locator fingerprint hashes the exact document
  URI, name, kind, real container name when present, and selection range.
- One result is limited to 5,000 symbols, depth 64, and 1,024 UTF-16 code units per name/container.
  The handle registry is limited to 20,000 live handles.

### Handle authority and invalidation

- `BridgeAdapterRequestContext` includes the physical authenticated `sessionId` supplied by the
  accepted handshake. Logical reconnecting state is never used as handle authority.
- Every handle uses a cryptographically random opaque ID and carries the adapter ID, physical
  session ID, and current workspace epoch as `validUntilEpoch`.
- Recomputing one document's symbols atomically replaces its previous handles. Document changes
  invalidate that document immediately. Reconnection, workspace identity/epoch changes, and
  disposal invalidate all handles.
- A consumer request carrying a handle with a different adapter/session or an epoch older than the
  current workspace is rejected as `STALE_SYMBOL` before routing.

### Daemon validation

- Before recursive schema validation, the daemon iteratively rejects document-symbol trees beyond
  5,000 nodes or depth 64.
- After schema validation, every nested symbol must have a unique handle ID, the routed adapter ID,
  the routed physical adapter session, exactly the current workspace epoch, and a locator whose URI
  is exactly the requested document and remains inside a registered root.
- A violation returns `PROVIDER_FAILED` to the consumer and closes the adapter session with a policy
  violation. The daemon never forwards the invalid result.

## Consequences

- Consumers receive real provider-derived VS Code symbol trees for exact unsaved revisions.
- Handles cannot be transferred across reconnects or used after document/epoch invalidation.
- Provider absence is evaluated per requested document. The capability means the adapter implements
  the provider route, not that every language in a multi-root workspace has a provider.
- The double revision capture hashes the buffer twice per request. This cost is accepted for the
  coherence guarantee and remains asynchronous on the extension host.
- `workspace/searchSymbols`, `symbol/resolveAt`, `symbol/getDefinition`,
  `symbol/getReferences`, `symbol/getImplementations`, controlled locator relocation, and dynamic
  capability-change notification remain separate increments.

## Alternatives considered

### Inspect extension registrations or execute arbitrary commands

Rejected. VS Code exposes no supported provider registry for this purpose, and arbitrary command
execution would violate the protocol security boundary.

### Parse or scan source when no provider exists

Rejected. That would be a textual approximation mislabeled as semantic and could silently select
the wrong symbol.

### Use the logical reconnecting connection as handle identity

Rejected. A logical connection spans multiple physical authenticated sessions. Session-bound
authority must rotate on every handshake.

### Trust schema-valid nested handles

Rejected. Schema validation proves shape, not adapter/session/workspace ownership or URI scope.
