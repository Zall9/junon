# ADR-0010 — WebSocket Heartbeat and Session Expiration

## Status

Accepted — 2026-08-01

## Context

ADR-0001 selected daemon-originated WebSocket ping frames but did not define cadence, missed-pong
semantics, activity refresh, option bounds, or cleanup reason propagation. The registry records
`lastActivityAt`, yet before this decision only application messages touched it and authenticated
sessions never expired.

The protocol also defines adapter-originated `ide/ping`. Treating that method as the transport
heartbeat would leave quiet consumer sessions uncovered and duplicate WebSocket liveness support.
Wall-clock elapsed time is unsuitable for missed-heartbeat accounting because clock changes and an
event-loop stall could expire a responsive peer before it receives a new ping opportunity.

## Decision

### Ownership and cadence

- The daemon owns liveness and sends empty WebSocket ping control frames to every authenticated
  adapter and consumer session.
- Standards-compliant clients answer with pong control frames. The Node `ws` client does this
  automatically; no application message or public client timer is added.
- The default interval is 15 seconds. Configuration is bounded from 1 through 60 seconds.
- A session may miss three complete pong response windows by default. The threshold is configurable
  from 1 through 10.
- Heartbeat timers are unref'ed and one transport-wide interval sweeps all sessions. No timer is
  allocated per session.

### Activity and expiration

- A valid pong or any authenticated application message proves peer activity, resets the missed
  heartbeat count, and touches the registry `lastActivityAt` wall-clock timestamp.
- Sending data or receiving no peer traffic does not prove liveness.
- Each sweep first expires sessions that have already exhausted their configured complete response
  windows; otherwise it sends one ping and records one outstanding heartbeat.
- Accounting uses missed ping opportunities rather than wall-clock subtraction. A delayed daemon
  event loop therefore advances at most one heartbeat step when it resumes.
- `ide/ping` remains a schema-validated adapter diagnostic/latency probe. It is ordinary application
  activity but is not automatically scheduled and is not required for consumer liveness.

### Closure and cleanup

- Expiration closes only the affected socket with WebSocket code 1001 and a generic `Session
  expired` reason.
- Authenticated close reasons are classified as `session-expired`, `shutdown`, `transport-lost`, or
  `error` and passed to the router. Only the canonical enum is broadcast; raw socket reasons are
  never forwarded.
- The existing single `sessionClosed` path remains authoritative: it removes registry state,
  invalidates plans/undo tokens, cancels consumer-owned routes, fails adapter-owned routes, removes
  adapter/workspace state, and broadcasts `adapter/disconnected` when applicable.
- Normal peer close code 1000 and daemon shutdown classify as `shutdown`; protocol/dispatcher/send
  failures classify as `error`; other transport loss remains `transport-lost`.

### Reconnection

- A one-shot client observes expiration as an ordinary physical connection close.
- The ADR-0009 lifetime facade starts its normal discovery-file reconnection flow. No expired
  session identity or operation is replayed.
- A responsive shared client should not expire because its WebSocket stack automatically returns
  pong frames even when no IDEBP application requests are active.

## Consequences

- Quiet but healthy adapter and consumer sessions remain alive without protocol chatter.
- Half-open or non-responsive authenticated sessions are removed with bounded shared timer state.
- Consumers can distinguish an expired adapter from generic transport loss through the existing
  canonical notification reason.
- Deterministic tests can invoke the same sweep operation directly; production still uses the
  transport-wide interval.

## Alternatives considered

### Schedule `ide/ping` from every shared client

Rejected because the method is adapter-originated, does not cover non-TypeScript clients uniformly,
and duplicates WebSocket control-frame liveness.

### Expire by wall-clock idle duration

Rejected because clock jumps and event-loop stalls can incorrectly consume several heartbeat
windows at once.

### Allocate one timeout per session

Rejected because a single bounded sweep is simpler and avoids per-session timer growth.
