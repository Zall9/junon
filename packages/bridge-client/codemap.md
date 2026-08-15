# packages/bridge-client/

## Responsibility

The TypeScript client both ends use, so the JSON-RPC layer is written once (TASK.md §17): discovery,
authentication, typed requests and notifications, timeouts, cancellation, version checking, runtime
validation, reconnection, and typed errors.

## Design

**Two-phase connection.** The socket is not usable until `bridge/handshake` has been answered and
validated; only then is an `AuthenticatedBridgeConnection` constructed. There is no window in which a
half-authenticated connection can be used by mistake.

**A facade over an engine.** `AuthenticatedBridgeConnection` delegates to `ClientJsonRpcEngine`,
which owns pending requests, inbound handlers, role authorisation and socket lifetime.
`ReconnectingBridgeConnection` wraps that again with a _logical_ lifetime, re-attaching registered
handlers to each physical connection.

**Role decides direction.** An adapter may register inbound handlers and may send only
`$/cancelRequest`; a consumer may subscribe to notifications and may not answer requests. Sending in
the wrong direction is refused by the client rather than by the daemon closing the session.

**Late answers are absorbed, not treated as violations.** A request that timed out or was cancelled
leaves a tombstone for 30 s, so a response arriving afterwards is consumed quietly.

## Flow

```
discovery/    read the 0600 file, refuse it if its permissions widened
   │
connection/connect.ts        open socket → bridge/handshake → validate → authenticated connection
connection/json-rpc-engine   request multiplexing, per-request timeout + AbortSignal, inbound
                             dispatch with capacity, completion grace windows
connection/reconnecting      bounded exponential backoff with jitter, rereads discovery each retry,
                             republishes handlers, publishes {connected|reconnecting|closed}
```

Reconnection state deliberately carries no discovery path, endpoint, token or raw error.

## Integration

Used by the VS Code extension (adapter role), the CLI and conformance harnesses (consumer role), and
the daemon's own tests. The Kotlin and Python clients are separate implementations of the same
contract — `jetbrains-plugin/.../connection/` and `integrations/serena/junon/client.py` — because a
JVM plugin and a Python process cannot import this one.
