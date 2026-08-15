# Phase 3 VS Code document symbols audit — 2026-08-02

## Scope

This increment audited and implemented provider-backed `document/getSymbols` for the VS Code
adapter. The audit covered:

- the canonical document/symbol/error schemas and ADR-0002, ADR-0003, ADR-0005, ADR-0006,
  ADR-0008, ADR-0009, ADR-0013, ADR-0014, and ADR-0015;
- VS Code `DocumentSymbol`, `SymbolInformation`, `SymbolKind`, range, command, and cancellation
  semantics in the pinned API types;
- physical authenticated session ownership across the shared reconnecting client;
- revision coherence while an asynchronous provider runs;
- nested result bounds, handle invalidation, daemon authority checks, and real loopback routing.

## Audit findings and remediation

### Provider discovery and truthful availability

VS Code exposes no supported document-symbol provider registry. The adapter therefore invokes only
the fixed `vscode.executeDocumentSymbolProvider` API command. `undefined`/`null` returns
`CAPABILITY_UNAVAILABLE`; an empty array is a successful result. Provider exceptions or malformed
DTOs return payload-free `PROVIDER_FAILED`. No parser, regex scan, or textual fallback exists.

### Physical session authority

The shared inbound handler context exposed request ID, method, and cancellation but not the physical
handshake session. A logical reconnecting connection spans multiple physical sessions, so it cannot
mint a safe symbol handle by itself.

`BridgeAdapterRequestContext` now carries the accepted physical `sessionId`. The VS Code handle
registry uses that session, the adapter ID, and current workspace epoch for every opaque random
handle. A real daemon integration test compares the returned handle session with
`bridge/listAdapters`.

### Symbol DTO normalization

All 26 VS Code kinds map exactly to IDEBP. Hierarchical `DocumentSymbol` trees preserve children and
actual parent container names. Flat `SymbolInformation` results preserve exact provider locations
and non-empty container names. The mapper refuses foreign URIs, mixed/malformed forms, unsupported
kinds, invalid or non-contained ranges, blank/oversized names, cycles, more than 5,000 nodes, or
depth beyond 64. It does not invent `qualifiedName`.

Fingerprints include the exact URI, simple name, kind, real container name when present, and UTF-16
selection range, so same-name overloads at different ranges remain distinct.

### Revision race

The first implementation captured the document before invoking the asynchronous provider but did
not prove that the buffer remained unchanged when the provider completed. It now captures the exact
in-memory revision both before and after the call. Any editor version, content hash, or workspace
epoch difference returns canonical `STALE_DOCUMENT` with the current revision before handles are
materialized.

### Handle invalidation

Document changes invalidate matching handles synchronously before the 75 ms notification debounce.
Reconnection, workspace identity/epoch transitions, lifecycle disposal, and explicit semantic-state
invalidation clear the complete registry. Recomputing one document's symbols atomically replaces
its old handles. The registry is limited to 20,000 live handles.

### Daemon trust boundary

The daemon previously validated only the document wrapper of a `document/getSymbols` response. It
now iteratively rejects more than 5,000 nodes or depth beyond 64 before recursive Ajv validation.
After canonical schema validation, it requires every handle ID to be unique and every nested handle
to match the routed adapter, physical session, and exact current epoch. Every locator must name the
exact requested document inside a registered root.

Consumer-supplied handles are rejected as `STALE_SYMBOL` before routing when their adapter/session
does not match or `validUntilEpoch` is older than the current workspace. Invalid provider results
return `PROVIDER_FAILED` and close the adapter with policy code 1008.

The post-implementation audit added the pre-Ajv structural bound after identifying that a deeply
nested schema-valid candidate could otherwise reach recursive validation first. Tests cover foreign
sessions, future epochs, foreign locator URIs, duplicate IDs, and excessive depth.

## Implementation

- `bridge-client/json-rpc-engine.ts`: physical session ID in inbound handler context;
- `vscode-extension/symbol-mapper.ts`: exact provider DTO mapping, fingerprints, bounds, and bounded
  handle registry;
- `vscode-extension/symbol-routes.ts`: fixed provider route, revision bracketing, canonical errors,
  handle materialization, and response-size guard;
- `vscode-extension/extension.ts`: handler wiring and truthful provider/semantic capability;
- `vscode-extension/event-bridge.ts`: immediate document handle invalidation hook;
- daemon application router: handle-epoch request check plus pre/post-schema symbol authority
  validation.

ADR-0016 records the durable choices and explicit remaining gaps.

## Validation evidence

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install across seven workspace projects: pass;
- Prettier and ESLint: pass;
- strict TypeScript typecheck across six packages plus scripts: pass;
- all six TypeScript builds and autonomous extension bundle checks: pass;
- VS Code package: 10 files / 41 tests, including a real authenticated daemon symbol route;
- bridge daemon: 9 files / 74 tests, including five adversarial nested-symbol response cases;
- bridge client: 7 files / 44 tests, including physical session context dispatch;
- complete Vitest suite: 39 files / 238 tests;
- protocol runtime catalogue: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness and CLI smoke: pass;
- deterministic TypeScript fixture, Java source compilation, and four PHP lint checks: pass.

The extension bundle is 612.5 KiB and the daemon child bundle is 657.9 KiB before source maps.

## Remaining limitations

- `workspace/searchSymbols`, `symbol/resolveAt`, `symbol/getDefinition`, `symbol/getReferences`, and
  `symbol/getImplementations` remain unavailable and unadvertised.
- Controlled locator relocation is not implemented; no route currently consumes the new registry.
- Diagnostics and prepare/apply/undo operations remain unavailable in the VS Code adapter.
- Dynamic trust, document rename, and document delete event propagation remain explicit gaps.
- Native Windows discovery ownership/ACL support and remote daemon auto-start remain unavailable.
- VSIX inspection and a real `@vscode/test-electron` extension-host launch remain Phase 3 work.

## Next audit boundary

Before `workspace/searchSymbols`, audit query/result bounds, fixed provider command semantics,
multi-root and exact URI ownership, flat-result normalization, per-document revision capture,
partial provider availability, cancellation/timeouts, result ordering, and whether workspace-search
handles can be invalidated without an unbounded document registry.
