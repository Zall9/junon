# ADR-0009 — Shared Client Reconnection Lifecycle

## Status

Accepted — 2026-08-01

## Context

The one-shot shared client owns one authenticated WebSocket and correctly rejects its pending work
when that socket closes. Phase 2 also requires automatic recovery after a daemon restart. A restart
can rotate both the loopback port and authentication token, and every successful handshake creates
a new session. Reusing the old discovery snapshot, session-bound identifiers, or in-flight writes
would therefore be incorrect and could duplicate an operation whose previous outcome is unknown.

Adapters add another lifecycle requirement: the daemon loses adapter/workspace registration on
restart, while the client must preserve its local routed-method and notification subscriptions.
Connection loss, retry timers, handshake completion, session restoration, and explicit shutdown can
all race.

## Decision

### API and discovery

- Reconnection is an opt-in lifetime facade created from a discovery-file path. Existing one-shot
  connection APIs keep their current semantics.
- The initial connection must succeed before the facade is returned. Automatic retries begin only
  after that established connection is lost.
- Every retry rereads and fully revalidates the private discovery file. No endpoint or token snapshot
  survives between attempts.
- Failed reads, connection attempts, authentication, and restoration remain retryable because an
  atomic discovery-file replacement may supersede stale state. Each attempt still applies all
  permission, ownership, loopback, version, handshake, and runtime checks.

### Backoff and lifecycle

- Retry uses exponential backoff with configurable initial delay, maximum delay, multiplier, and
  jitter ratio. Defaults are 100 ms, 5 seconds, 2, and 20%; hard delay bounds are 1 ms through 60
  seconds, multiplier 1 through 10, and jitter 0 through 1.
- Only one connection or retry attempt exists at a time. A monotonically increasing generation and
  exact connection identity prevent an old close/completion from replacing a newer connection.
- The facade exposes cloned `connected`, `reconnecting`, and `closed` state snapshots. Listener
  failures are contained and no authentication/discovery data appears in state.
- Explicit `close()` is terminal and idempotent. It aborts retry delay, handshake, and restoration,
  closes the active/candidate socket, and never starts another attempt.

### Request semantics

- Pending requests retain the one-shot engine behavior and reject when their physical connection
  closes.
- Requests and notifications submitted while reconnecting fail immediately with a typed
  `BridgeClientReconnectingError`. They are not queued.
- No request, notification, cancellation, plan, undo token, symbol handle, or other session-bound
  value is automatically replayed. The caller must decide whether a new operation is safe.

### Handler and adapter restoration

- Routed request handlers and notification handlers are logical facade registrations. They are
  attached to every physical connection and retain their existing singular/multiple-handler rules.
- A configurable session-restoration callback runs after handlers are attached but before a new
  connection becomes visible as `connected`. An adapter uses it to send a fresh `ide/register` from
  current IDE state; consumers normally omit it.
- Restoration receives the previous session, retry attempt, and an `AbortSignal`. It has a 30-second
  default timeout, bounded from 1 ms through 300 seconds.
- Timeout or shutdown aborts the restoration signal and closes the candidate connection. If the
  callback ignores cancellation, no subsequent restoration attempt starts until its actual promise
  settles, preventing hidden unbounded restoration work.

## Consequences

- Daemon port/token rotation is handled without weakening discovery-file validation.
- Applications can distinguish temporary reconnecting state from terminal closure.
- Adapter registrations are rebuilt from current IDE state instead of a stale cached registration.
- Callers must explicitly retry safe reads if desired; the client never guesses whether a write was
  applied.
- Heartbeat and server-side session expiration are defined by ADR-0010. Expiration surfaces as
  physical connection loss and then uses this same reconnection lifecycle.

## Alternatives considered

### Reuse the previous discovery object

Rejected because a daemon restart normally changes the port and secret.

### Replay pending requests automatically

Rejected because transport loss does not prove that the daemon or adapter failed to apply the
operation. Replaying prepare/apply/undo or even cancellation could violate one-shot semantics.

### Cache and replay the last `ide/register` request

Rejected because workspace roots, trust, readiness, and capabilities can change after initial
registration. The adapter must rebuild registration from current IDE state.

### Start retries before the first connection succeeds

Rejected for this API because it would return no authenticated capability and make initial
configuration/security errors difficult to surface. A future supervisor may wrap initial startup
separately.
