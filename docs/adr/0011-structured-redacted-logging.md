# ADR-0011 — Structured Redacted Logging

## Status

Accepted — 2026-08-01

## Context

Phase 2 requires structured logs containing a level, component, request identifier, session
identifier when relevant, duration, and result. Authentication tokens, complete source content,
replacement text, and sensitive diagnostic data must never be logged.

A conventional `logger.info(message, context)` API is unsafe at this boundary: request parameters,
provider exceptions, URIs, diagnostic messages, and replacement text could be attached accidentally.
Raw request identifiers are also client-controlled and may themselves contain a secret or source
fragment. Logging every message without a bound could amplify a local notification flood, while a
throwing sink must not alter protocol behavior.

## Decision

### Closed event catalogue

- The daemon logger exposes event-specific methods, not arbitrary messages or context maps.
- The initial catalogue is `daemon.started`, `daemon.stopped`, `handshake.rejected`,
  `session.opened`, `session.closed`, `rpc.message.processed`, and
  `observability.events_dropped`.
- Records contain only explicitly constructed fields: `timestamp`, `level`, `component`, `event`,
  `result`, and, where applicable, `requestId`, `sessionId`, `method`, `role`, `reason`,
  `durationMs`, or `droppedCount`.
- Raw messages, request parameters, response results, error objects/messages/stacks, URIs, adapter
  or workspace metadata, source content, edit text, and diagnostics are not accepted by the sink
  boundary.

### Correlation and time

- Every raw JSON-RPC request identifier is replaced with a process-local HMAC-SHA-256 correlation
  value before serialization. The HMAC key is at least 256 random bits and is never exposed.
- The same request identifier correlates within one logger/process, but values do not correlate
  across daemon restarts or independently keyed logger instances.
- Daemon-generated session identifiers may be logged because their constrained random form carries
  no client payload. Client names, versions, and topology are not logged.
- Timestamps are UTC ISO-8601 values. Durations use a monotonic clock, are finite, non-negative, and
  rounded to milliseconds; wall-clock changes cannot create negative durations.

### Levels, volume, and sinks

- Supported thresholds are `debug`, `info`, `warn`, `error`, and `silent`.
- The daemon library uses a silent/no-op logger unless an explicit structured logger is supplied.
  The future CLI selects a level and JSON-lines sink.
- Emission is bounded per monotonic one-second window. Excess records are counted in bounded state
  and summarized once by `observability.events_dropped` when a later window opens.
- Each event has a fixed, small field set; no serialized record contains an unbounded user value.
- Serialization failures, clock failures, and synchronous sink failures are contained and never
  fail a handshake, request, session cleanup, or daemon shutdown. Logging never recursively logs
  its own failure.
- A JSON-lines stderr sink is provided for the CLI, but the protocol core has no logging dependency.

### Result semantics

- `rpc.message.processed` measures authenticated daemon dispatch time, not remote provider
  completion time. Its result is `processed` or `error`.
- Handshake rejection reasons are canonical safe values only. Presented tokens, raw validation
  errors, and peer payloads are never included.
- Session closure uses the existing canonical `session-expired`, `shutdown`, `transport-lost`, or
  `error` reason.

## Consequences

- Required operational correlation is available without retaining client-controlled identifiers.
- Adding a new field or event requires an explicit code change and security review.
- Application payload debugging must use purpose-built safe metrics or opt-in tooling; arbitrary
  payload dumping is intentionally unsupported.
- Operators may lose individual records above the configured rate, but receive a bounded dropped
  count and protocol work remains unaffected.

## Alternatives considered

### Generic structured context with recursive key redaction

Rejected because secrets can appear under unknown keys, inside arrays, or in request identifiers;
deny-list redaction cannot prove absence.

### Log raw request identifiers

Rejected because identifiers are peer-controlled strings and can contain tokens or source text.

### Log provider exception messages after truncation

Rejected because truncation limits size, not sensitivity. Only canonical result/reason enums cross
the logging boundary.

### Unbounded asynchronous logging queue

Rejected because a slow or failed sink could retain sensitive operational state and consume
unbounded memory.
