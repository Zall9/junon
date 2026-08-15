# Phase 2 handshake and transport increment audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The loopback WebSocket boundary and first-message
handshake state machine satisfy their current local acceptance criteria and may support the shared
client increment. This is not a Phase 2 completion verdict: durable session/adapter/workspace
registries, heartbeat and expiration, authenticated application routing, cancellation, plan
storage, CLI health checks, client reconnection, and Windows discovery ACLs remain pending.

## Scope

- ADR-0001 handshake ordering, failure classification, limits, and transport abstraction
- canonical handshake request/response/error and common identifier/version schemas
- shared Ajv runtime handshake classification
- authentication, role/topology binding, version negotiation, and session creation
- actual WebSocket listening, framing, state transitions, closure, and dispatch boundary
- local denial-of-service limits and secret-safe failures
- dependency and Node 24 compatibility

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-HS-AUD-01 | High | Full schema validation made a missing token `INVALID_REQUEST`, contradicting the documented generic `AUTHENTICATION_FAILED` behavior. | ADR-0001 now defines precedence explicitly; shared Ajv classification returns authentication failure only when every schema issue is authentication-local. |
| P2-HS-AUD-02 | High | Numeric JSON-RPC IDs outside JavaScript's safe range could not be echoed exactly; text IDs and protocol versions were unbounded before authentication. | Canonical schemas now require safe integers, cap text IDs at 256 characters and versions at 64, with three negative fixtures. |
| P2-HS-AUD-03 | Medium | The handshake response duplicated the session-ID pattern. | Replaced it with the canonical `identifiers.schema.json#/$defs/sessionId` reference. |
| P2-HS-AUD-04 | High | An idle unauthenticated socket had no deadline. | Added a five-second handshake timeout configurable only downward; integration coverage verifies session-free expiry. |
| P2-HS-AUD-05 | High | A pipelined message could close the socket while the asynchronous handshake send callback later registered a session. | Session registration now requires the connection to remain in `sending-handshake` with an open socket; pre-response messages close without dispatch or session creation. |
| P2-HS-AUD-06 | High | `ws` can report successful sends with a runtime `null` callback value despite typings using an optional error; this caused success to be treated as failure. | Normalized `null` to `undefined` at the transport boundary and verified normal close codes and session lifecycle over real sockets. |
| P2-HS-AUD-07 | Medium | The initial callback exposed no transport-neutral response mechanism and exposed mutable session objects. | Added `AuthenticatedTransportConnection` with `send`, `close`, and cloned session snapshots; the WebSocket type remains private to the adapter. |
| P2-HS-AUD-08 | Medium | Configurable daemon metadata/topology could produce schema-invalid responses, and processor/dispatcher exceptions could escape the socket handler. | Fixed MVP daemon metadata/topology to valid local values and contained synchronous/asynchronous failures to the affected connection with code `1011`. |

No unresolved correctness finding remains in this increment.

## Verified invariants

- listener host is hardcoded to `127.0.0.1`, the peer address is rechecked, the port is dynamic, and
  only `/rpc` upgrades are accepted
- per-message deflate is disabled and payloads are capped at 10 MiB, configurable only downward
- no application message is dispatched before the successful handshake response has been sent
- missing, malformed, and mismatching credentials share one generic error and never echo a token
- adapter and consumer roles create sessions bound to the selected version and declared topology
- inverted or disjoint version ranges create no session; selection chooses the highest supported
  discrete version in the inclusive client range
- failures return at most one safe handshake error where possible and close the connection
- idle, oversized, pipelined, wrong-method, repeated-handshake, processor-failure, and
  dispatcher-failure paths are covered over actual loopback sockets

## Node 24.15.0 evidence

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 17 files, 98 tests; real loopback run outside sandbox
pnpm protocol:fixtures            # 161 entries, 35 fixtures
pnpm protocol:generate:check
```

The daemon-specific result is 5 files / 28 tests, including 11 WebSocket integration scenarios.
The GitHub Actions workflow still requires execution on a hosted runner.

## Next audited boundary

The next increment is the shared TypeScript client's WebSocket connection and authenticated
handshake. It must validate the daemon response canonically, expose typed authentication/version
errors, enforce its own response timeout, and avoid dispatching client calls before authentication.
Only after that boundary is accepted can the Serena consumer establish a real session.
