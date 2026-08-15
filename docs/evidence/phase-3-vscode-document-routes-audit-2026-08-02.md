# Phase 3 VS Code document routes and events audit — 2026-08-02

## Scope

This increment audited and implemented the first routed VS Code operations:

- `document/read`;
- `document/getRevision`;
- `document/opened`, `document/changed`, `document/saved`, and `document/closed`;
- `workspace/rootsChanged`, plus truthful empty/non-empty workspace transitions.

The audit covered canonical document/event/error schemas, ADR-0002, ADR-0005, ADR-0006,
ADR-0008, ADR-0009, ADR-0013, ADR-0014, the shared reconnecting client, daemon routing and
workspace containment, VS Code URI/root selection, unsaved buffers, cancellation, message bounds,
event ordering, and reconnection restoration.

## Audit findings and remediation

### Capability publication race

The lifecycle previously had no hook to attach routed handlers before `ide/register`. Advertising a
new capability from the registration callback would therefore create a window in which consumers
could route to an adapter without the matching handler.

The lifecycle now configures the logical reconnecting connection before registration. Its handlers
persist across candidate connections, while post-registration synchronization starts only after the
daemon owns the workspace.

### URI and editor authority

A document read must not translate a protocol URI to a local path or bypass VS Code filesystem
providers. The adapter now requires strict/exact URI serialization, selects the most-specific root
through `getWorkspaceFolder`, verifies that root against the stable workspace model, and reads only
through `openTextDocument`. The returned text and revision therefore reflect dirty in-memory
buffers and remote/custom filesystem providers.

### Daemon trust of adapter document DTOs

The daemon previously schema-validated document route results and checked only workspace ownership
for document notifications. A schema-valid adapter could return or broadcast a document outside the
registered root, with a stale epoch, wrong root, or different URI from the request.

The router now independently enforces workspace ID, registered root ID, current epoch, URI
containment, and exact routed target URI for document reads/revisions/symbol results. Document event
references receive the same scope checks; rename validates both old and new URIs. Invalid results
return `PROVIDER_FAILED` and close the adapter; invalid notifications close before broadcast.

### Extension-host work and event ordering

The mapper captures one in-memory snapshot and hashes it through WebCrypto's asynchronous digest
path. Change events are coalesced per URI for 75 ms with at most 1,024 pending timers. Save and close
flush a pending change first, and a serialized projection preserves send order. Live callback
failures are contained so reconnect-time notification rejection cannot become an unhandled promise.

Existing open documents are projected only after registration and again after a new session is
registered. No cached request or notification is replayed. Root updates emit `rootsChanged` only
while non-empty; actual empty/non-empty transitions use `workspace/closed`/`workspace/opened`.

The post-implementation audit found that a route could otherwise observe VS Code's new folder epoch
before `rootsChanged` was written. Document routes now use the last successfully projected workspace
snapshot. That projection advances after the notification write, preserving same-adapter-socket
ordering for later responses; an already-running old-epoch request may fail closed but cannot be
misrepresented as current.

### Missing trust contract

The canonical protocol has no `workspace/trustChanged` notification. A synthetic close/open would
misrepresent the IDE state, while adding a strict notification under version 0.1.0 needs a protocol
compatibility decision. Dynamic trust propagation is therefore explicitly deferred. This increment
has no write capability, so a stale untrusted registry state cannot authorize a write.

Rename and delete events are also deferred until a bounded reference cache or pre-delete capture can
always produce the required revision-bearing document reference. No approximate event is emitted.

## Implementation

- `document-mapper.ts`: captured snapshot plus asynchronous SHA-256 mapping;
- `document-routes.ts`: exact native reads/revisions, cancellation, error normalization, and 10 MiB
  response guard;
- `event-bridge.ts`: post-registration listeners, coalescing, ordering, root reconciliation, and
  reconnect resynchronization;
- `adapter-lifecycle.ts`: handler-before-registration and post-registration hooks;
- `extension.ts`: two truthful native capabilities and VS Code host wiring;
- daemon application router: exact document target/root/epoch/containment enforcement.

ADR-0015 records the durable choices and explicit gaps.

## Validation evidence

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install across seven workspace projects: pass;
- Prettier and ESLint: pass;
- strict TypeScript typecheck: pass;
- all six TypeScript builds, autonomous extension bundle checks, and CLI smoke: pass;
- VS Code package: 8 files / 30 tests, including a real loopback daemon route;
- bridge daemon: 9 files / 69 tests, including out-of-root event and wrong-target response rejection;
- complete Vitest suite: 37 files / 222 tests;
- protocol runtime catalogue: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture, Java source compilation, and PHP lint: pass.

The extension bundle is 599.9 KiB and the daemon child bundle is 654.9 KiB before source maps.

## Remaining limitations

- `document/getSymbols`, symbol operations, diagnostics, and prepare/apply operations remain
  unavailable and unadvertised.
- Dynamic trust, document rename, and document delete event propagation remain explicit gaps.
- Native Windows discovery ownership/ACL support and remote daemon auto-start remain unavailable.
- VSIX inspection and a real `@vscode/test-electron` extension-host launch remain Phase 3 work.

## Next audit boundary

Before `document/getSymbols` or workspace symbol search, audit provider invocation semantics,
provider-result normalization, symbol kind/range mapping, duplicate and nested symbols, handle
identity/epoch ownership, partial provider availability per language, cancellation, smart/provider
timeouts, and strict refusal when no real provider exists.
