# ADR-0008 — Adapter Inbound Request Dispatch

## Status

Accepted — 2026-08-01

## Context

The shared TypeScript client originally handled outbound requests, responses, and notifications but
treated every incoming object containing `method` as a notification. Once the daemon began routing
consumer operations, a TypeScript adapter therefore closed its healthy connection on the first
routed request.

Inbound dispatch crosses a write-capable security boundary. It must not turn unknown methods into
arbitrary callbacks, expose handler exceptions, accept duplicate route IDs, or let abandoned work
grow without bounds. Cancellation, timeout, handler completion, socket failure, and unregistering a
handler can race.

## Decision

### Role authority

- Only an authenticated `adapter` connection may register inbound application handlers.
- Handlers exist only for the thirteen methods routed by the daemon: nine read operations plus
  prepare/apply/discard/undo.
- Adapter-originated application requests remain limited to register, unregister, and ping.
- Consumer-originated requests remain limited to daemon-local and routed consumer methods.
- Adapter outbound notifications are limited to capability/workspace/document/diagnostic events;
  consumers may originate only `$/cancelRequest`.
- An adapter accepts only `$/cancelRequest` as an inbound notification. A consumer accepts only
  daemon/broadcast lifecycle events. A valid message in the wrong direction is a protocol
  violation, not an ignored message.

### Handler API

Exactly one handler may be registered per routed method. The handler receives schema-validated
parameters and a context containing the request ID, exact method, and an `AbortSignal`. Removing a
handler prevents new dispatch but does not change a request that already captured it.

No raw WebSocket or unvalidated JSON-RPC escape hatch is exposed.

### Bounded execution

- At most 128 inbound requests execute concurrently by default; configuration may lower or raise
  this only within a hard maximum of 1,024.
- Each handler has a 30-second default timeout, configurable from 1 ms through 300 seconds.
- Capacity rejection returns normalized `PRECONDITION_FAILED`; a missing handler returns
  `CAPABILITY_UNAVAILABLE`.
- Timeout and daemon cancellation abort the handler signal and produce one normalized response.
- A timed-out or cancelled handler retains its execution slot until its promise actually settles,
  so a handler that ignores `AbortSignal` cannot be used to accumulate unbounded hidden work.
- Socket close or protocol failure aborts every handler without attempting further writes.

### Settlement and validation

Inbound request IDs are unique while active and during a bounded 30-second completion grace period.
A duplicate or malformed request, an unauthorized method/direction, or cancellation for a genuinely
unknown request is a protocol violation and closes only that connection. One late cancellation for
a just-completed request is absorbed from the bounded grace set because consumer cancellation and
adapter completion travel on different sockets and may cross.

The first of handler completion, declared handler error, cancellation, timeout, or connection close
owns settlement. Late handler completion is ignored. Success values are validated against the exact
method response schema before transmission. A handler may throw `BridgeAdapterRequestError` carrying
canonical error data; unexpected exceptions and invalid results become generic `PROVIDER_FAILED`
without exposing exception messages or stack traces.

## Consequences

- VS Code and other TypeScript adapters can use the shared client for both directions.
- Cancellation reaches IDE work through a standard `AbortSignal`.
- Slow or malicious peers cannot create unbounded handler state.
- Role mistakes fail locally before transmission and wrong-direction server messages fail closed.
- Reconnection remains separate: reconnecting creates a new authenticated connection and handlers
  must be registered on that new connection.

## Alternatives considered

### Multiple handlers per method

Rejected because more than one component could answer the same JSON-RPC ID and violate single
settlement.

### Ignore unknown cancellation IDs

Rejected for the authenticated daemon-to-adapter link because the daemon must only cancel route IDs
it previously sent. Ignoring a mismatch would hide state divergence.

### Forward arbitrary thrown errors

Rejected because exception messages and stacks can contain source, paths, or provider internals and
do not satisfy the canonical normalized error schema.
