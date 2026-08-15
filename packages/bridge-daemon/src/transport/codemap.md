# packages/bridge-daemon/src/transport/

## Responsibility

WebSocket transport layer for the IDE Bridge daemon. It provides transport interfaces and a loopback-only server with authenticated state transitions, bounded control-frame heartbeat/session expiration, canonical close reasons, typed handshake-rejection callbacks, and application dispatch callbacks. The transport is independent from the router, registry, and concrete log sink.

## Design Patterns

- **Strategy / Interface**: `ServerTransport` (`transport.ts:13`) and `AuthenticatedTransportConnection` (`transport.ts:7`) are abstract interfaces. `LoopbackWebSocketServer` implements `ServerTransport`; `WebSocketTransportConnection` implements `AuthenticatedTransportConnection`.
- **State Machine**: Each connection has a `ConnectionState` (`loopback-websocket-server.ts:45-49`): `awaiting-handshake` → `sending-handshake` → `authenticated` → `closing`. Transitions are guarded by the `state.kind` check at each message handler entry.
- **Callback Injection**: `LoopbackWebSocketServerOptions` (`loopback-websocket-server.ts:27-43`) lifecycle callbacks cover authenticated messages, session open/activity/close, and typed handshake rejection — keeping the transport independent from the router, registry, and concrete log sink.
- **Shared Heartbeat Sweep**: one unref'ed interval sends ping frames to every authenticated socket; bounded per-session outstanding counts reset on pong or application traffic.
- **Defensive Copying**: `WebSocketTransportConnection.session` getter returns `structuredClone(this.#session)` (`loopback-websocket-server.ts:96`) to prevent external mutation of internal session state.
- **Loopback Enforcement**: `request.socket.remoteAddress` must be `"127.0.0.1"` or `"::ffff:127.0.0.1"` (`loopback-websocket-server.ts:195`). Any other address results in `socket.terminate()`.
- **Observability Isolation**: `#reportHandshakeRejection` (`loopback-websocket-server.ts:425`) wraps the `onHandshakeRejected` callback in try/catch — observability callbacks cannot influence the handshake state machine.

## Key Types

- `ServerTransport` (`transport.ts:13`): Interface with `endpoint: string | undefined`, `start(): Promise<string>`, `close(): Promise<void>`.
- `AuthenticatedTransportConnection` (`transport.ts:7`): Interface with `session: AuthenticatedSession`, `send(message: unknown): Promise<void>`, `close(code?, reason?): void`.
- `SessionCloseReason` (`transport.ts:5`): Derived from `IDEBPNotificationParams<"adapter/disconnected">["reason"]` — canonical `shutdown | transport-lost | session-expired | error` close classification reused by adapter notifications.
- `ConnectionState` (`loopback-websocket-server.ts:45-49`): Discriminated union — `{ kind: "awaiting-handshake" }`, `{ kind: "sending-handshake" }`, `{ kind: "authenticated"; connection: AuthenticatedTransportConnection }`, `{ kind: "closing" }`.
- `SessionSocketRecord` (`loopback-websocket-server.ts:51-55`): `connection`, `outstandingHeartbeats: number`, `closeReason: SessionCloseReason`.
- `LoopbackWebSocketServerOptions` (`loopback-websocket-server.ts:27-43`): extends `HandshakeProcessorOptions` with `maxMessageBytes?`, `handshakeTimeoutMs?`, `heartbeatIntervalMs?`, `maxMissedHeartbeats?`, and lifecycle callbacks: `onAuthenticatedMessage` (required), `onSessionOpened?`, `onSessionActivity?`, `onSessionClosed?`, `onHandshakeRejected?`.
- `HandshakeRejectionReason` (from `structured-logger.ts:22`): `"timeout" | "invalid-request" | "authentication-failed" | "unsupported-version" | "error"` — typed rejection reasons for observability.
- `WebSocketTransportConnection` (`loopback-websocket-server.ts:80`): Private class wrapping a `WebSocket` + `AuthenticatedSession`. Implements `AuthenticatedTransportConnection`.
- Constants: `DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024` (`:19`), `DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000` (`:20`), `DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000` (`:21`), `MIN_HEARTBEAT_INTERVAL_MS = 1_000` (`:22`), `MAX_HEARTBEAT_INTERVAL_MS = 60_000` (`:23`), `DEFAULT_MAX_MISSED_HEARTBEATS = 3` (`:24`), `MAX_MISSED_HEARTBEATS = 10` (`:25`).

## Key Functions

- `LoopbackWebSocketServer.start()` (`loopback-websocket-server.ts:182`): Creates a `WebSocketServer` bound to `127.0.0.1:0` at path `/rpc` with `perMessageDeflate: false`. Waits for `"listening"` event, starts heartbeat interval, returns `ws://127.0.0.1:<port>/rpc`.
- `LoopbackWebSocketServer.close()` (`loopback-websocket-server.ts:244`): Terminates all client sockets, clears `#sessions`, closes the `WebSocketServer`. Idempotent — returns immediately if already closed.
- `LoopbackWebSocketServer.sweepSessions()` (`loopback-websocket-server.ts:226`): Advances one heartbeat opportunity. Expires sessions with `outstandingHeartbeats >= maxMissedHeartbeats` (close `1001`, reason `"session-expired"`). Sends ping to the rest. Ping failure → terminate, reason `"error"`.
- `#handleConnection(socket)` (`loopback-websocket-server.ts:268`): Sets up the per-connection state machine, handshake timeout (unref'd), and message/close/error/pong listeners.
- `#reportHandshakeRejection(reason)` (`loopback-websocket-server.ts:425`): Calls `onHandshakeRejected` callback in try/catch. Observability failures are silently contained — they cannot affect the handshake state machine.
- `parseTextMessage(data, isBinary)` (`loopback-websocket-server.ts:57`): Rejects binary messages, handles `RawData` in all forms (array, ArrayBuffer, Buffer), returns `JSON.parse` result.
- `sendJson(socket, value, callback)` (`loopback-websocket-server.ts:67`): `JSON.stringify` + `socket.send` with error-first callback.
- `sendFailureAndClose(socket, response)` (`loopback-websocket-server.ts:73`): Sends a JSON error response, then closes with code `1008` ("Handshake rejected") or terminates on send failure.

## Data & Control Flow

1. `start()` → `new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/rpc", maxPayload, perMessageDeflate: false })` → waits for `"listening"` → starts heartbeat interval (unref'd) → returns endpoint string.
2. New connection → `"connection"` event → check `request.socket.remoteAddress` against loopback whitelist → `terminate()` if not loopback → `#handleConnection(socket)`.
3. `#handleConnection`: state = `awaiting-handshake`, start handshake timeout (unref'd).
4. First message → `parseTextMessage` → if parse fails, report `"invalid-request"` rejection, send `InvalidRequest` and close.
5. `HandshakeProcessor.process(value)` → map failure code to canonical rejection reason: `AUTHENTICATION_FAILED` → `"authentication-failed"`, `UNSUPPORTED_PROTOCOL_VERSION` → `"unsupported-version"`, else → `"invalid-request"` (`loopback-websocket-server.ts:367-373`) → `sendFailureAndClose` → state = `closing`.
6. Handshake processing throw → report `"error"` rejection → close `1011` (`loopback-websocket-server.ts:360-362`).
7. Handshake timeout → report `"timeout"` rejection → close `1008` (`loopback-websocket-server.ts:275-276`).
8. If accepted → send handshake response → on send success → `onSessionOpened(connection)` → state = `authenticated` → register in `#sessions` map.
9. Subsequent messages → if state = `authenticated` and not a `bridge/handshake` method → `onAuthenticatedMessage(connection, message)`.
10. If a `bridge/handshake` method arrives post-auth → rejected with `InvalidRequest` response but session NOT closed (`loopback-websocket-server.ts:328-336`).
11. Heartbeat sweep → expire an exhausted counter or send ping; pong/application activity resets it.
12. Close event → delete from `#sessions`, classify canonical reason (code `1000` + `transport-lost` → `shutdown`), call `onSessionClosed`.

## Integration Points

- **Consumed by**: `IDEBPDaemonServer` (`daemon-server.ts:36`) constructs and owns a `LoopbackWebSocketServer`.
- **Depends on**: `ws` (WebSocket library), `node:net` (`AddressInfo`), `../session/handshake-processor.js` (`HandshakeProcessor`, `AuthenticatedSession`, `createInvalidHandshakeRequestResponse`), `../observability/structured-logger.js` (`HandshakeRejectionReason` type only).
- **External boundaries**: TCP socket on `127.0.0.1`, path `/rpc`. `maxPayload` enforced by `ws` at `DEFAULT_MAX_MESSAGE_BYTES`. Handshake timeout via `setTimeout` (unref'd).

## Common Gotchas

- `perMessageDeflate: false` is explicit (`loopback-websocket-server.ts:190`) — compression is disabled to avoid complexity and potential attacks.
- The handshake timeout timer is `.unref()`-ed (`loopback-websocket-server.ts:279`) so it won't keep the Node process alive.
- `maxMessageBytes` and `handshakeTimeoutMs` constructor validation rejects values exceeding the defaults (`loopback-websocket-server.ts:129-145`) — you can lower them but not raise them.
- Messages arriving while `state.kind === "sending-handshake"` are rejected with code `1008` ("Handshake response is pending") and reason `"invalid-request"` (`loopback-websocket-server.ts:305-309`) — no pipelining before authentication completes.
- Socket errors contain no raw error propagation; they classify the later authenticated close as canonical `error` (`loopback-websocket-server.ts:281`) and the close handler performs cleanup.
- Do not implement heartbeat with `ide/ping`: that method is an adapter diagnostic probe, while WebSocket control frames cover both roles.
- Post-authentication handshake requests (`method === "bridge/handshake"`) are silently rejected with an `InvalidRequest` response but do NOT close the connection (`loopback-websocket-server.ts:328-336`) — the session remains authenticated and usable.
- `#reportHandshakeRejection` wraps the callback in try/catch (`loopback-websocket-server.ts:425-431`) — a throwing observability callback cannot break the handshake state machine.
- The `onSessionOpened` callback failure (thrown exception) causes the connection to close with code `1011` ("Session initialization failed") (`loopback-websocket-server.ts:396-399`).
- Async dispatch errors from `onAuthenticatedMessage` are caught and result in close code `1011` (`loopback-websocket-server.ts:346-350`).
- `SessionCloseReason` is derived from the protocol's `adapter/disconnected` notification params (`transport.ts:5`) — the transport does not define its own close-reason enum; it reuses the canonical protocol values.
