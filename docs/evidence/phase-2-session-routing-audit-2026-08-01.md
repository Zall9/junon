# Phase 2 session registry and routing audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The composed daemon now owns authenticated
session, adapter, workspace, capability, and readiness state; answers registry-local methods; routes
the nine read-only document/symbol/diagnostics methods to the exact workspace owner; rewrites
connection-scoped JSON-RPC IDs; propagates timeout and cancellation; and removes ownership on
disconnect or unregister.

This is not a Phase 2 completion verdict. Prepare/apply operations remain unavailable until the plan
store can enforce plan ownership and one-time consumption. Adapter-side inbound request support in
the shared TypeScript client, heartbeat/expiration, reconnection, CLI/doctor, and structured logging
also remain pending.

## Audited boundary

- role authority for requests, responses, and notifications
- session → adapter → workspace ownership and cleanup
- ID correlation across multiple consumers and adapters
- local registry methods and runtime response validation
- workspace routing and symbol-handle ownership
- notification authorization, registry mutation, and consumer broadcast
- timeout, cancellation, late response, disconnect, and unregister races
- in-flight resource bounds and route ID generation
- interaction with the previously implemented typed client

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-ROUTE-AUD-01 | Critical | The product documents named roles but defined only `ide/register` as adapter-only. Other message directions were ambiguous and could be interpreted differently by each adapter. | Added ADR-0006 with an explicit role matrix. Requests with IDs return `PERMISSION_DENIED`; unauthorized notifications fail closed. |
| P2-ROUTE-AUD-02 | Critical | JSON-RPC IDs are scoped to a connection. Forwarding consumer IDs unchanged lets two consumers collide at one adapter and makes cancellation ownership ambiguous. | The daemon assigns a bounded, cryptographically random route ID and stores the original ID with both session owners, workspace, and method. Tests route identical consumer IDs concurrently and complete them out of order. |
| P2-ROUTE-AUD-03 | Critical | Caller-supplied registration could claim workspaces whose `adapterId` points elsewhere or reuse a live workspace ID. | Registration atomically rejects mismatched, duplicate, or already-owned IDs. Workspace ownership is never selected heuristically. |
| P2-ROUTE-AUD-04 | High | The transport tracked sockets but exposed no reliable authenticated-open/close lifecycle to an application registry. | Added contained session lifecycle hooks and a composed `IDEBPDaemonServer`; registry insertion precedes application dispatch and close cleanup executes once. |
| P2-ROUTE-AUD-05 | High | Relaying prepare/apply methods without a plan store would bypass session/workspace binding, expiry, preconditions, and atomic consumption. | These four methods return `CAPABILITY_UNAVAILABLE` for now. Only the nine read-only routed methods are enabled; plan operations remain an explicit next increment. |
| P2-ROUTE-AUD-06 | High | Symbol handles carry adapter and session ownership that workspace-only routing could ignore. | Handle-bearing requests must match both the registered workspace adapter and its current session or fail with `STALE_SYMBOL` before reaching an adapter. |
| P2-ROUTE-AUD-07 | High | Timeout, consumer cancellation, disconnect, unregister, and late adapter responses can race. | Route settlement is single-owner; cancellation is looked up by `(consumer session, original ID)`; cancelled routes become bounded tombstones; adapter loss fails active requests; consumer loss cancels only its work. |
| P2-ROUTE-AUD-08 | Medium | A consumer may disconnect after an adapter completes but before response delivery. Propagating that send failure would incorrectly close the healthy adapter. | Consumer delivery failure is contained after route settlement. Adapter protocol violations still close only the offending adapter. |
| P2-ROUTE-AUD-09 | Medium | Workspace root events could replay or regress `workspaceEpoch`. | Root updates now require a strictly increasing epoch and exact adapter/workspace ownership. |
| P2-ROUTE-AUD-10 | Medium | Unbounded in-flight state would permit local resource exhaustion. | Defaults are bounded to 1,024 total active/tombstoned routes and 128 active routes per consumer, with validated configurable limits and 30-second timeout/grace windows. |

No unresolved correctness finding remains inside this increment's declared boundary.

## Verified behavior

- adapter and consumer sessions enter the registry immediately after successful handshake
- adapter registration, clean unregistration, reconnectable cleanup, and initial readiness state
- local status, adapter/session/workspace listing, workspace lookup/status, capability lookup, and
  adapter ping
- schema validation before dispatch and before locally generated success responses
- strict role enforcement and rejection of cross-adapter workspace claims
- multi-consumer correlation with identical original IDs and out-of-order adapter responses
- workspace-not-found and adapter-not-found errors without implicit cross-routing
- symbol handles from another adapter/session rejected before forwarding
- owner-only cancellation, route-ID cancellation forwarding, timeout error, and valid late-response
  absorption
- active requests fail with `ADAPTER_DISCONNECTED` on adapter transport loss
- malformed or method-inconsistent adapter responses close that adapter and clean registry ownership
- authorized readiness events mutate registry state and reach typed client notification handlers
- a real typed adapter client can register and a real typed consumer can query registry state through
  the composed loopback daemon

## Node 24.15.0 evidence

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 22 files, 134 tests
pnpm protocol:fixtures            # 161 entries, 35 fixtures
pnpm protocol:generate:check
```

Daemon package: 6 files / 37 tests. Bridge-client package: 5 files / 26 tests. The real hosted
GitHub Actions run remains unverified.

## Next audited boundary

The next increment should add the plan store and intercept prepare/apply/discard/undo so that
adapter-produced plans are checked and rebound to the exact route owner before consumers receive
them. The shared client then needs an inbound request dispatcher before a TypeScript IDE adapter can
serve routed calls. Serena can use the consumer side only after at least one real adapter implements
that inbound path.
