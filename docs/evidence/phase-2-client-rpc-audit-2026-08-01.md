# Phase 2 bridge-client application RPC increment audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The shared TypeScript client now makes
schema-validated typed requests for all 23 IDEBP application methods, validates each success
response against the method correlated to its request ID, maps normalized errors, sends and
receives all 14 notifications, and implements per-request timeout and `AbortSignal` cancellation
through `$/cancelRequest`.

This is not a Phase 2 completion verdict. Daemon application routing and cancellation propagation,
the adapter-side inbound request dispatcher, automatic reconnection, durable session state,
heartbeat/expiration, and plan storage remain pending.

## Audited boundary

- all method request/response and notification schemas
- reusable runtime validation without duplicating wire constraints
- request ID allocation, correlation, reuse, and unknown-ID handling
- method-specific success validation and normalized error mapping
- timeout, cancellation, response, send-error, and connection-close races
- outgoing and incoming notification validation
- secret-safe error surfaces
- behavior after malformed, duplicate, unknown, and late responses

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-RPC-AUD-01 | High | Generated types did not provide a reusable method-to-request/response runtime registry. Individual consumers would otherwise duplicate schema selection or skip validation. | Added a protocol-owned registry for all 23 methods and 14 notifications. Every validator compiles the canonical JSON Schema `$defs`; a drift test compares the exported catalog with schema method constants. |
| P2-RPC-AUD-02 | High | A JSON-RPC success envelope does not identify its method, so generic response validation cannot establish the result contract. | The client retains the method with every pending ID and validates the complete response against that method's canonical response schema before resolving. |
| P2-RPC-AUD-03 | High | Timeout, abort, response, and send callbacks can race and settle a request more than once. | Pending entries are removed atomically; timeout and abort listeners are cleared by the winning path; cancellation is emitted at most once. |
| P2-RPC-AUD-04 | High | A valid response may arrive after local timeout or cancellation. Treating it as an unknown-ID attack would incorrectly close healthy sessions. | Added a bounded 1,024-entry, 30-second late-response set retaining the original method. One canonical late success or error is absorbed; malformed, duplicate, or genuinely unknown responses still close with code `1002`. |
| P2-RPC-AUD-05 | Medium | Runtime errors could expose arbitrary daemon error messages. | `BridgeClientRpcError` exposes only the canonical IDEBP code, retryability, and schema-validated structured details; its message is generic. |
| P2-RPC-AUD-06 | Medium | Outgoing typed values can still be invalid at runtime through untyped callers or stale compiled JavaScript. | Requests and notifications are validated against canonical schemas before serialization or transmission. |
| P2-RPC-AUD-07 | Medium | The pre-existing daemon test for the `sending-handshake` state depended on an unspecified race between an outbound write callback and a second inbound frame. | Replaced the race with a deterministic security assertion: application frames queued behind a rejected handshake are never dispatched. The complete suite then passed twice consecutively. |
| P2-RPC-AUD-08 | Medium | Supporting inbound requests now would require inventing routing and authorization behavior not yet implemented by the daemon. | Kept inbound application requests fail-closed. The adapter-side dispatcher is explicitly deferred to the daemon routing increment rather than approximated. |

No unresolved correctness finding remains inside this increment's declared boundary.

## Verified behavior

- compile-time request params and result types are selected by the exact method string
- outgoing requests and notifications fail before transmission when runtime schema validation fails
- incoming success responses require a known ID and the pending method's exact result schema
- incoming normalized errors produce typed, generic-message client errors
- unknown methods, binary messages, invalid JSON, malformed responses, wrong result shapes, and
  unknown IDs close the affected connection
- timeouts default to 30 seconds and are configurable from 1 ms through 300 seconds
- timeout and `AbortSignal` rejection send the sole canonical `$/cancelRequest {id}` notification
- repeated abort signals emit one cancellation only
- one schema-valid late response after local cancellation is ignored without weakening unknown-ID
  enforcement
- notification handlers receive schema-validated params and can be unsubscribed
- no raw JSON-RPC send/receive escape hatch is exposed

## Node 24.15.0 evidence

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 20 files, 124 tests; repeated twice after race remediation
pnpm protocol:fixtures            # 161 entries, 35 fixtures
pnpm protocol:generate:check
```

Protocol runtime registry tests: 9 files / 69 tests. Bridge-client tests: 4 files / 25 tests. The
real hosted GitHub Actions run remains unverified.

## Next audited boundary

The next increment should audit and implement the daemon application dispatcher and session
registry before reconnection. That boundary must define role authorization, request ownership,
workspace/adapter routing, error correlation, in-flight cancellation propagation, and inbound
adapter requests together; implementing any one in isolation would leave ambiguous authority.
