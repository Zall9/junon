# packages/bridge-daemon/src/observability/

## Responsibility

Provides the daemon's deny-by-default structured logging boundary. `StructuredLogger`
emits a closed catalogue of small JSON-lines records, pseudonymizes peer-controlled
request identifiers via HMAC-SHA-256, bounds event volume with a fixed-window token
bucket (default 1000 entries/sec), and contains clock, serialization, and sink
failures. It never accepts protocol payloads, provider errors, source text, edit
replacements, URIs, or diagnostic contents — only allowlisted session IDs, canonical
methods, and correlated (HMAC'd) request IDs. All logging failures are swallowed:
logging is observational and must never affect protocol behavior
(`structured-logger.ts:240-243`, `structured-logger.ts:277-279`).

## Design Patterns

- **Closed Event API**: Event-specific methods (`daemonStarted`, `daemonStopped`,
  `handshakeRejected`, `sessionOpened`, `sessionClosed`, `rpcMessageProcessed`)
  construct allowlisted records. There is no generic message/context method
  (`structured-logger.ts:134-223`).
- **Process-Local Correlation**: Raw JSON-RPC request IDs become truncated
  HMAC-SHA-256 digests under a private 256-bit-or-larger key. The correlated ID
  is `request_` + 22 base64url chars of the HMAC. Correlation values are
  process-local and change across independently keyed logger instances
  (`structured-logger.ts:322-328`).
- **Fixed-Window Rate Limiter**: At most `maxEntriesPerSecond` records are emitted
  per monotonic one-second window. Excess records are counted silently; when a
  new window opens, a single `observability.events_dropped` warn record carries
  the dropped count. The window uses a monotonic clock (`performance.now()`)
  to avoid wall-clock skew (`structured-logger.ts:245-270`).
- **Null Object Sink**: A logger without a sink uses `NOOP_SINK`. The daemon
  defaults to a silent logger (`minimumLevel: "silent"`) unless one is supplied
  explicitly (`structured-logger.ts:70`, `daemon-server.ts:33`).
- **Failure Containment**: All observational work — clock reads, serialization,
  sink writes, rate-limit arithmetic — is wrapped in `try/catch` that silently
  swallows errors. No secondary log is attempted on failure
  (`structured-logger.ts:240-243`, `structured-logger.ts:277-279`).
- **Deny-by-Default Validation**: Session IDs, roles, methods, and reasons are
  validated against allowlists before inclusion in records. Invalid values cause
  the event to be silently dropped (method returns early), never thrown
  (`structured-logger.ts:300-320`).

## Key Types

- `StructuredLogger` (`structured-logger.ts:92-329`): The logging facade class.
  Private fields: `#minimumLevel`, `#sink`, `#maxEntriesPerSecond`,
  `#correlationKey: Buffer`, `#now`, `#monotonicNow`, `#windowStartedAt`,
  `#emittedInWindow`, `#droppedInWindow`.
- `StructuredLogRecord` (`structured-logger.ts:25-45`): The 12-field JSON record:
  `timestamp`, `level`, `component`, `event`, `result`, `requestId?`, `sessionId?`,
  `method?`, `role?`, `reason?`, `durationMs?`, `droppedCount?`. The `component`
  union is `"daemon" | "transport" | "session" | "router" | "observability"`. The
  `event` union is the 7 closed events listed below.
- `StructuredLogLevel` (`structured-logger.ts:20`): `"debug" | "info" | "warn" | "error" | "silent"`.
  Priority order: debug(10) < info(20) < warn(30) < error(40) < silent(Infinity)
  (`structured-logger.ts:62-68`).
- `StructuredLogSink` (`structured-logger.ts:21`): `(jsonLine: string) => void` —
  synchronous consumer of one newline-terminated JSON record.
- `StructuredLoggerOptions` (`structured-logger.ts:47-54`): Configuration:
  `minimumLevel?`, `sink?`, `maxEntriesPerSecond?`, `correlationKey?: Uint8Array`
  (32–1024 bytes, default 32 random bytes), `now?`, `monotonicNow?`.
- `RpcLogMetadata` (`structured-logger.ts:56-60`): `sessionId`, optional `requestId`
  (raw JSON-RPC ID for HMAC correlation), optional `method`.
- `HandshakeRejectionReason` (`structured-logger.ts:22-23`): Union of 5 canonical
  reasons: `"authentication-failed" | "unsupported-version" | "invalid-request" | "timeout" | "error"`.
  No peer payload is logged.
- `DEFAULT_MAX_LOG_ENTRIES_PER_SECOND` (`structured-logger.ts:17`): `1_000` — the
  default rate limit.
- `MAX_LOG_ENTRIES_PER_SECOND` (`structured-logger.ts:18`): `10_000` — the hard
  maximum configurable rate limit.
- `MethodActivity` (`metrics-registry.ts:33-40`): Per-method counters for
  `MetricsRegistry`: `callCount`, `refusalCount`, `incompleteCount`, and a
  fixed-size latency sample array (`LATENCY_SAMPLES = 256`).
- `RecentQuery` (`metrics-registry.ts:42-47`): Ring-buffer entry for
  `MetricsRegistry`: `query` (string), `method` (string), `at` (monotonic ms).
  Capped at `QUERY_RING = 50` entries.
- `MetricsSnapshot` (`metrics-registry.ts:49-58`): Immutable copy of all
  registry counters and recent queries returned by `snapshot()`.
- `MetricsRegistry` (`metrics-registry.ts:60-143`): In-memory metrics store.
  Counters and latency samples are keyed by method; recent queries are kept in
  a ring buffer. **Never written to logs** — the registry is an in-process
  observability surface only (ADR-0035, ADR-0011).
- Constants: `LATENCY_SAMPLES = 256` (`metrics-registry.ts:28`), `QUERY_RING =
50` (`metrics-registry.ts:31`).

## Key Functions

- `createStderrJsonLineSink(): StructuredLogSink` (`structured-logger.ts:86-90`):
  Factory returning a sink that writes JSON lines to `process.stderr`.
- `StructuredLogger` constructor (`structured-logger.ts:103-128`): Validates
  `minimumLevel` (defaults `"info"`), `maxEntriesPerSecond` (1–10000, defaults
  1000), `correlationKey` (32–1024 bytes, defaults `randomBytes(32)`). Stores
  `correlationKey` as `Buffer`. Throws on invalid options.
- `beginOperation(): number` (`structured-logger.ts:130-132`): Returns a safe
  monotonic timestamp to pass to `rpcMessageProcessed` for duration measurement.
- `daemonStarted(): void` (`structured-logger.ts:134-141`): Emits
  `{level: "info", component: "daemon", event: "daemon.started", result: "success"}`.
- `daemonStopped(): void` (`structured-logger.ts:143-150`): Emits
  `{level: "info", component: "daemon", event: "daemon.stopped", result: "success"}`.
- `handshakeRejected(reason): void` (`structured-logger.ts:152-162`): Validates
  reason against allowlist. Emits `handshake.rejected` at `"error"` level if reason
  is `"error"`, otherwise `"warn"`. Invalid reasons cause silent return.
- `sessionOpened(sessionId, role): void` (`structured-logger.ts:164-176`):
  Validates session ID (pattern `^session_[A-Za-z0-9_-]+$`, max 128 chars) and
  role (`"adapter" | "consumer"`). Emits `session.opened` at info level. Invalid
  values cause silent return.
- `sessionClosed(sessionId, role, reason): void` (`structured-logger.ts:178-192`):
  Validates all three fields. Level is `"error"` if reason is `"error"`, `"info"`
  if reason is `"shutdown"`, otherwise `"warn"`. Result is `"error"` if reason is
  `"error"`, otherwise `"success"`.
- `rpcMessageProcessed(metadata, startedAt, result): void`
  (`structured-logger.ts:194-223`): Validates session ID. Method is included only
  if it passes `isIDEBPApplicationMethod` or `isIDEBPNotificationMethod`. Request
  ID is HMAC-correlated via `#correlateRequestId` if it passes
  `isJSONRPCRequestIdentifier`. Duration is computed from `startedAt` (monotonic)
  to now, rounded to milliseconds. Emits `rpc.message.processed` at `"error"` or
  `"info"` level based on `result` parameter.
- `#emit(event): void` (`structured-logger.ts:225-243`): Core emission path. Checks
  level priority, rotates the rate-limit window, enforces the token bucket, calls
  `#write`. All errors swallowed.
- `#rotateWindow(monotonicNow): void` (`structured-logger.ts:245-270`): If 1000+ ms
  have elapsed since window start, resets counters. If any records were dropped in
  the previous window, emits one `observability.events_dropped` warn record in the
  new window (if warn level is enabled and budget allows).
- `#write(event): void` (`structured-logger.ts:272-280`): Stamps `timestamp` from
  `#safeNow()`, constructs full `StructuredLogRecord`, `JSON.stringify`s it,
  appends `\n`, passes to sink. Errors swallowed.
- `#safeNow(): Date` (`structured-logger.ts:282-289`): Returns `new Date()` or
  falls back to `new Date(0)` on failure.
- `#safeMonotonicNow(): number` (`structured-logger.ts:291-298`): Returns
  `performance.now()` or 0 on failure.
- `#safeSessionId(sessionId): SessionId | undefined` (`structured-logger.ts:300-306`):
  Validates string type, max 128 chars, pattern `^session_[A-Za-z0-9_-]+$`.
- `#safeRole(role): IDEBPSessionRole | undefined` (`structured-logger.ts:308-310`):
  Validates against `Set(["adapter", "consumer"])`.
- `#safeHandshakeRejectionReason(reason): HandshakeRejectionReason | undefined`
  (`structured-logger.ts:312-316`): Validates against the 5-reason allowlist.
- `#safeSessionCloseReason(reason): SessionCloseReason | undefined`
  (`structured-logger.ts:318-320`): Validates against the 4-reason allowlist:
  `"session-expired" | "shutdown" | "transport-lost" | "error"`.
- `#correlateRequestId(requestId): string` (`structured-logger.ts:322-328`):
  HMAC-SHA-256 over `${typeof requestId}:${String(requestId)}` using
  `#correlationKey`, base64url digest, sliced to 22 chars, prefixed with
  `request_`. Produces a stable pseudonymous ID for the same raw ID under the same
  key.
- `MetricsRegistry.recordCall(method, durationMs)` (`metrics-registry.ts:69-78`):
  Increments the method's call count and pushes the latency into a fixed-size
  reservoir (256 samples). Past the cap, the oldest sample is shifted out.
- `MetricsRegistry.recordRefusal(code, method?)` (`metrics-registry.ts:86-91`):
  Increments the refusal counter for the given error code, optionally attributed
  to a method. The `method` param is optional because malformed requests carry no
  method.
- `MetricsRegistry.recordIncomplete(method)` (`metrics-registry.ts:94-96`):
  Increments the incomplete-response counter for the given method (triggered
  when `result.truncated === true`).
- `MetricsRegistry.recordQuery(query, method, at?)` (`metrics-registry.ts:105-109`):
  Pushes a `RecentQuery` into the ring buffer (50 entries). The one place user
  text is kept — capped, memory-only, and hideable.
- `MetricsRegistry.snapshot(): MetricsSnapshot` (`metrics-registry.ts:112-137`):
  Returns a deep copy of all counters, latency percentiles, and recent queries.
  Readers cannot mutate the daemon's live counters.
- `MetricsRegistry.forgetQueries()` (`metrics-registry.ts:140-142`): Clears the
  recent-query ring buffer.
- `percentile(sorted, fraction)` (`metrics-registry.ts:145-150`): Module-level
  nearest-rank percentile helper — no interpolation.

## Data & Control Flow

1. **Lifecycle events**: `IDEBPDaemonServer.start()` calls
   `logger.daemonStarted()` (`daemon-server.ts:94`). `close()` calls
   `logger.daemonStopped()` if it was running (`daemon-server.ts:109`).
2. **Handshake rejections**: `LoopbackWebSocketServer` calls
   `logger.handshakeRejected(reason)` via the `onHandshakeRejected` callback
   (`daemon-server.ts:70-72`). Only canonical `HandshakeRejectionReason` values
   are passed.
3. **Session events**: `onSessionOpened` callback calls
   `logger.sessionOpened(sessionId, role)` (`daemon-server.ts:60`).
   `onSessionClosed` calls `logger.sessionClosed(sessionId, role, reason)`
   (`daemon-server.ts:68`).
4. **RPC dispatch**: `onAuthenticatedMessage` calls `logger.beginOperation()` to
   get a monotonic start timestamp (`daemon-server.ts:74`). The daemon extracts
   only `sessionId`, `requestId`, and `method` from the raw message via
   `rpcLogMetadata()` (`daemon-server.ts:114-131`). After `router.handle()`
   resolves, `logger.rpcMessageProcessed(metadata, startedAt, "processed")` is
   called; on throw, `"error"` result is logged and the error is re-thrown
   (`daemon-server.ts:76-82`).
5. **Inside `#emit`**: Level priority check → window rotation → token-bucket
   check → `#write` → `JSON.stringify` → sink. Any failure at any step is
   swallowed.
6. **Dropped records**: When the token bucket is exhausted, `#droppedInWindow` is
   incremented and the event is silently dropped. On the next window rotation,
   if any records were dropped, a single `observability.events_dropped` record
   is emitted with the count (`structured-logger.ts:252-269`).

## Integration Points

- **Consumed by**:
  - `IDEBPDaemonServer` (`daemon-server.ts:8,29,33`) — creates and owns the
    logger instance; calls all six event methods.
  - `LoopbackWebSocketServer` (`loopback-websocket-server.ts:12`) — imports
    `HandshakeRejectionReason` type only (does not call logging methods
    directly; the daemon wires the callback).
  - Re-exported from package public API (`index.ts:15`).
- **Depends on**:
  - `@ide-bridge/protocol` — types only: `isIDEBPApplicationMethod`,
    `isIDEBPNotificationMethod`, `isJSONRPCRequestIdentifier`,
    `IDEBPApplicationMethod`, `IDEBPNotificationMethod`, `IDEBPSessionRole`,
    `JSONRPCRequestIdentifier`, `SessionId` (`structured-logger.ts:4-13`).
    The protocol package never imports observability code (dependency is
    one-directional).
  - `../transport/transport.js` — type only: `SessionCloseReason`
    (`structured-logger.ts:15`).
  - `node:crypto` — `createHmac`, `randomBytes` (`structured-logger.ts:1`).
  - `node:perf_hooks` — `performance` for monotonic clock
    (`structured-logger.ts:2`).
- **External boundaries**:
  - Default sink: `createStderrJsonLineSink()` writes to `process.stderr`
    (`structured-logger.ts:86-90`).
  - Correlation key: 32–1024 bytes, default 32 random bytes via
    `randomBytes(32)` (`structured-logger.ts:118`). The key is process-local and
    not persisted; correlation values change across restarts.
  - No env vars, no file paths, no HTTP routes. The logger is a pure in-process
    boundary.

## Common Gotchas

- **`rpc.message.processed` measures daemon dispatch, not adapter completion**:
  The duration is from `beginOperation()` to after `router.handle()` resolves
  (`daemon-server.ts:74-82`). For routed requests, this includes the full
  adapter round-trip. For local requests, it includes only local processing.
- **Correlation values are not stable across instances**: Each `StructuredLogger`
  with a different `correlationKey` produces different HMAC digests for the same
  raw request ID. The key is process-local and defaults to random bytes, so
  correlation values change across daemon restarts (`structured-logger.ts:118`,
  `structured-logger.ts:322-328`).
- **Dropped records are summarized lazily**: The `observability.events_dropped`
  record is emitted only when a later eligible event opens a new window. If the
  daemon shuts down during a window with dropped records, the dropped count is
  lost (`structured-logger.ts:252-269`).
- **`createStderrJsonLineSink()` is synchronous by contract**: The sink type is
  `(jsonLine: string) => void`. Sink ownership, destination rotation, and async
  flushing belong to the caller (future CLI/process layer). The logger never
  buffers or retries (`structured-logger.ts:21,86-90`).
- **Invalid inputs cause silent drops, not errors**: If a session ID, role,
  method, or reason fails validation, the event method returns early without
  logging. This is by design — logging must never throw — but it means
  misconfigured callers will silently lose log records (`structured-logger.ts:152-176`,
  `structured-logger.ts:194-223`).
- **All logging failures are swallowed**: `#emit` and `#write` wrap everything in
  `try/catch` with empty catch blocks. If the sink throws, if `JSON.stringify`
  fails (circular references), or if the clock throws, the error is silently
  ignored. No secondary log is attempted (`structured-logger.ts:240-243`,
  `structured-logger.ts:277-279`).
- **Session ID validation is stricter than protocol**: The logger requires
  `^session_[A-Za-z0-9_-]+$` with max 128 chars (`structured-logger.ts:69,300-306`).
  This is an observational allowlist, not the protocol's full validation. A
  session ID that passes protocol validation but not this pattern will be
  silently dropped from logs.
- **Rate limit applies to all events equally**: There is no per-event-type
  priority. Under sustained load, `daemon.started` and `session.opened` can be
  dropped just like `rpc.message.processed`. The 1000/sec default is generous
  enough that this is unlikely in practice.
- **`MetricsRegistry` counters are keyed by method and error code**: These are
  closed sets defined in the protocol, so the registry's `Map` keys will never
  grow unbounded (`metrics-registry.ts:33-40`).
- **`recordQuery` is the one place user text is kept**: Search queries are
  stored in the ring buffer (50 entries, memory-only). They are never written to
  logs and can be cleared via `forgetQueries()` (`metrics-registry.ts:105-109`).
- **`recordRefusal` method param is optional**: Malformed requests that fail
  before method extraction have no method to attribute the refusal to
  (`metrics-registry.ts:86-91`).
- **Latency reservoir is fixed-size (256)**: Past the cap, the oldest sample is
  shifted out — the reservoir is not a sliding window of the last 256 calls, but
  a bounded ring (`metrics-registry.ts:28,69-78`).
- **`snapshot()` returns a copy**: Readers (e.g. CLI `status` command) get a
  deep clone so they cannot mutate the daemon's live counters
  (`metrics-registry.ts:112-137`).
