# Phase 2 bridge-client handshake increment audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The shared TypeScript client can securely load the
private discovery file and establish a schema-validated adapter or consumer session with the real
loopback daemon. This is not a Phase 2 completion verdict: typed application requests/responses,
notifications, cancellation, reconnection, heartbeat handling, and daemon routing remain pending.

## Scope

- client-side canonical validation of handshake success and error responses
- discovery-to-WebSocket connection establishment
- request/response correlation, role binding, and version verification
- connection, handshake, and incoming-message limits
- typed errors and secret-safe failure surfaces
- socket ownership, closure, and post-handshake boundary behavior
- real private-discovery-file → daemon → client integration

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-CLI-AUD-01 | High | The protocol package validated handshake requests but exposed no canonical runtime validator for daemon success/error responses. | Added shared Ajv classifiers and type guards for both response forms, with valid and secret-bearing invalid coverage. |
| P2-CLI-AUD-02 | High | Schema validity alone cannot prove that a response belongs to this request or session intent. | The client requires the exact request ID, requested role, and supported protocol version before exposing the connection. |
| P2-CLI-AUD-03 | High | Connection establishment had no client-owned deadline or incoming payload bound. | Added a four-second overall timeout capped at five seconds and a 10 MiB incoming-message limit; redirects and per-message compression are disabled. |
| P2-CLI-AUD-04 | Medium | Handshake failures could otherwise surface raw WebSocket or daemon payload details. | Added typed configuration, connection, timeout, protocol-violation, and protocol-rejection errors with generic messages and structured safe codes only. |
| P2-CLI-AUD-05 | Medium | Caller-owned `clientInfo` could be mutated after validation but before the asynchronous socket opened. | The validated request now snapshots topology and client identity before connection establishment; regression coverage mutates the caller object. |
| P2-CLI-AUD-06 | Medium | Discovery loading and authentication required two independent calls, allowing consumers to omit private-file checks. | Added `connectBridgeClientFromDiscoveryFile`, which composes permission/ownership/schema/version checks directly with the handshake. |
| P2-CLI-AUD-07 | Medium | Exposing a temporary raw send/receive API would bypass the required typed runtime dispatcher. | The authenticated connection currently exposes metadata, closure, and lifecycle only; unexpected application messages close it until the next audited RPC increment. |

No unresolved correctness finding remains in this increment.

## Verified invariants

- only canonical loopback discovery endpoints reach the WebSocket constructor
- discovery protocol version and handshake response protocol version must both equal the client's
  supported `0.1.0` contract
- a generated, schema-valid request ID is correlated exactly with success and error responses
- both adapter and consumer sessions work against the real daemon
- authentication rejection, unsupported version, malformed response, mismatched ID/role/version,
  timeout, and premature close map to typed, secret-safe errors
- session metadata is cloned and cannot mutate connection-owned state
- the complete Unix private-file writer/reader/authentication path succeeds over a real ephemeral
  `127.0.0.1` WebSocket

## Node 24.15.0 evidence

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 18 files, 112 tests; loopback tests outside sandbox
pnpm protocol:fixtures            # 161 entries, 35 fixtures
pnpm protocol:generate:check
```

The bridge-client result is 3 files / 17 tests. The real GitHub Actions workflow remains unverified
on a hosted runner.

## Next audited boundary

The next increment is the typed JSON-RPC engine shared by all TypeScript consumers: correlated
requests/responses, canonical incoming validation, notifications, per-request timeouts, and
`$/cancelRequest`. It must be accepted before adding automatic reconnection or attempting a Serena
workflow, because reconnecting an unvalidated dispatcher would multiply failure modes.
