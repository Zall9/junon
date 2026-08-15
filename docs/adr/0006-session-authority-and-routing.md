# ADR-0006 — Session Authority and Application Routing

## Status

Accepted — 2026-08-01

## Context

IDEBP authenticates every WebSocket and binds it to either an `adapter` or `consumer` session, but
the protocol catalog alone does not define which direction may originate each message. JSON-RPC
request identifiers are scoped to a connection, so two consumers may legitimately use the same ID.
Forwarding those IDs unchanged to a shared adapter would make response and cancellation ownership
ambiguous. Adapter registration also carries caller-supplied adapter and workspace identifiers that
must not be trusted without checking their relationship to the authenticated session.

The daemon needs one authority model before session registry, routing, cancellation, and adapter
integration can be implemented safely.

## Decision

### Ownership hierarchy

- Every authenticated connection owns exactly one session ID and immutable session role.
- An adapter session may register at most one adapter at a time.
- An adapter ID is owned by exactly one live adapter session.
- Every registered workspace belongs to exactly one registered adapter. Its `adapterId` must equal
  the adapter registration request's `adapterId`.
- Workspace IDs are globally unique among live registrations. The daemon never chooses between two
  adapters claiming the same workspace ID.
- Closing or unregistering an adapter session removes its adapter and workspaces atomically.
- Reconnection may reclaim identifiers only after the previous owning session has been removed.

### Role matrix

Adapter sessions may originate:

- `ide/register`, `ide/unregister`, and `ide/ping` requests;
- adapter capability, workspace, document, and diagnostics notifications, except
  `adapter/disconnected`, which is daemon-originated;
- success or normalized error responses for requests routed to that exact adapter session.

Consumer sessions may originate:

- `bridge/*`, `workspace/list`, `workspace/get`, `workspace/getStatus`, and
  `ide/getCapabilities` daemon-local requests;
- document, symbol, diagnostics, and prepare/apply requests routed through the workspace owner;
- `$/cancelRequest` only for an in-flight request owned by that same consumer session.

All other role/message combinations are rejected with a normalized `PERMISSION_DENIED` response
when a request ID is available. Invalid or unauthorized notifications close the affected connection
because notifications have no response channel.

### Routing and correlation

- Routed requests must contain a registered `workspaceId` whose owner is connected.
- The daemon replaces the consumer's request ID with a cryptographically random route ID before
  forwarding to the adapter.
- An in-flight record binds route ID, original consumer ID, consumer session, adapter session,
  workspace, and method. Responses are accepted only from the bound adapter session and validated
  against the retained method before the original ID is restored.
- A consumer may not reuse an ID while its request is in flight.
- Cancellation lookup uses the pair `(consumer session ID, original request ID)`. The daemon forwards
  `$/cancelRequest` with the route ID only to the bound adapter.
- After cancellation or timeout, the route remains as a bounded tombstone long enough to absorb one
  canonical late response without forwarding it. Unknown, duplicate, or malformed responses remain
  protocol violations.
- Adapter disconnect fails its outstanding consumer requests with `ADAPTER_DISCONNECTED`. Consumer
  disconnect cancels its outstanding adapter requests without sending responses to the closed
  consumer.

### Registry-owned local methods

The daemon answers `bridge/*`, `workspace/list`, `workspace/get`, `workspace/getStatus`,
`ide/getCapabilities`, adapter registration, unregistration, and ping from registry state. Newly
registered workspaces start in `initializing` readiness with unknown progress until an authorized
`workspace/readinessChanged` notification updates them.

Prepare/apply/discard/undo requests must be intercepted by the plan store rather than blindly
forwarded. The dual public/private identity and one-shot transition rules are defined by ADR-0007.

### Notifications

Authorized adapter notifications are validated, checked against registry ownership, applied to the
registry when they change adapter/workspace state, and then broadcast to authenticated consumers.
The daemon creates `adapter/disconnected` when an adapter transport closes unexpectedly. It does not
forward source text or replacement text because those values are absent from event contracts.

## Consequences

- Consumer IDs cannot collide at adapters or cancel another session's work.
- Registration cannot cross-claim another adapter's workspace.
- Role authorization is enforceable before dispatch rather than being left to adapters.
- Adapters must support inbound daemon requests and return the daemon-assigned route ID.
- The shared TypeScript client's inbound handler lifecycle and bounds are defined by ADR-0008.
- Loss and recreation of the physical client session follow ADR-0009; no old session-bound identity
  or operation is replayed.
- Routing state is intentionally in memory for MVP and is lost on daemon restart.
- Subscription filtering is deferred; authenticated consumers receive the canonical event stream.

## Alternatives considered

### Forward consumer IDs unchanged

Rejected because JSON-RPC IDs are connection-scoped and collide across consumers.

### Let adapters reject unauthorized calls

Rejected because it exposes adapters to cross-workspace requests and duplicates security policy.

### Select an adapter when workspace IDs collide

Rejected because the selection would be an implicit cross-route forbidden by the product scope.
