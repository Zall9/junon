# packages/bridge-client/src/connection/

## Responsibility

This directory implements both physical and logical connection lifecycles for the IDE Bridge client: authenticated WebSocket handshakes, bidirectional JSON-RPC (outbound requests plus inbound adapter request handling), and an opt-in reconnecting facade that survives daemon endpoint/token rotation without replaying work.

## Design Patterns

- **Two-Phase Handshake** (`connect.ts:101-232`): The client opens a WebSocket, sends a `bridge/handshake` request, validates the daemon's response, and only then constructs an `AuthenticatedBridgeConnection`. The socket is not usable before the handshake resolves.
- **Promise-Deferred Pattern** (`connect.ts:147-231`): Handshake uses a manually-managed `Promise` with `resolve`/`reject` closures and a `settled` flag to ensure single settlement despite multiple socket event listeners.
- **Engine-Delegation** (`authenticated-connection.ts`): `AuthenticatedBridgeConnection` is a thin facade that delegates `request`, `notify`, `onNotification`, `onRequest`, and `close` to the internal `ClientJsonRpcEngine`.
- **Request Multiplexing** (`json-rpc-engine.ts:150-153`): The engine tracks outbound pending requests by ID in a `Map`, each with its own timeout and `AbortSignal` listener, demultiplexing responses as they arrive.
- **Tombstone Tracking** (`json-rpc-engine.ts:46-47, 656-678`): When a request times out or is cancelled, its ID is remembered for 30 seconds so that a late response is silently consumed rather than treated as a protocol violation.
- **Best-Effort Cancellation** (`json-rpc-engine.ts:644-654`): On timeout or abort, a `$/cancelRequest` notification is sent to the daemon, but the outcome does not affect local settlement — the request is already rejected locally.
- **Bounded Inbound Dispatch** (`json-rpc-engine.ts:425-501`): Adapter handlers are singular per routed method, receive an `AbortSignal`, retain a capacity slot until their actual promise settles, and return method-validated results or normalized errors.
- **Inbound Completion Tracking** (`json-rpc-engine.ts:620-642`): Completed inbound request IDs are remembered for 30s (max 1024) to absorb one crossed late cancellation without treating it as a protocol violation.
- **Atomic Inbound Settlement** (`json-rpc-engine.ts:603-612`): Completion, cancellation, timeout, and close compete through identity-checked `#takeInbound`; the first settlement wins.
- **Generation-Safe Reconnection** (`reconnecting-connection.ts:321-379`): Every retry rereads private discovery metadata, uses bounded exponential backoff with jitter, and publishes only the exact restored candidate generation.
- **Persistent Logical Handlers** (`reconnecting-connection.ts:462-512`): Request and notification registrations attach to each physical connection while preserving disposal and role rules.
- **No-Replay Boundary** (`reconnecting-connection.ts:315-319`): In-flight calls reject on physical loss; calls during reconnect fail immediately with `BridgeClientReconnectingError`.

## Key Types

### `ConnectBridgeClientOptions` (`connect.ts:41-49`)

```typescript
{
  discovery: IDEBPDiscoveryFile;       // Parsed discovery data (endpoint, token, etc.)
  role: IDEBPSessionRole;              // Client's role in the session
  topology: IDEBPEndpointTopology;     // Client's endpoint topology
  clientInfo?: { name: string; version: string };  // Defaults to CLIENT_NAME/CLIENT_VERSION
  handshakeTimeoutMs?: number;         // Defaults to 4000, max 5000
  createRequestId?: () => JSONRPCRequestIdentifier;  // Custom ID generator for handshake
  signal?: AbortSignal;                // Cancels a handshake attempt
  inboundRequestTimeoutMs?: number;    // Defaults to 30000, max 300000
  maxInboundRequests?: number;         // Defaults to 128, max 1024
}
```

Extends `BridgeInboundRequestOptions` to carry adapter-side limits into the engine.

### `ConnectBridgeClientFromDiscoveryFileOptions` (`connect.ts:51-60`)

`Omit<ConnectBridgeClientOptions, "discovery">` plus `endpointOverride?: string` — same options but without `discovery`, since it is read from a file path. The override replaces only the validated discovery endpoint; authentication and all other metadata still come from the private discovery file.

### `AuthenticatedBridgeSession` (`authenticated-connection.ts:24-30`)

```typescript
{
  sessionId: SessionId;
  role: IDEBPSessionRole;
  protocolVersion: IDEBPProtocolVersion;
  daemonInfo: {
    name: string;
    version: string;
  }
  daemonTopology: IDEBPEndpointTopology;
}
```

Immutable snapshot of the handshake result. `AuthenticatedBridgeConnection.session` getter returns a `structuredClone` of this (`authenticated-connection.ts:55-57`).

### `AuthenticatedBridgeConnection` (`authenticated-connection.ts:32-95`)

Facade class wrapping a `WebSocket` + `ClientJsonRpcEngine`. Exposes `request()`, `notify()`, `onNotification()`, `onRequest()`, `close()`, `session`, `isOpen`, and `closed: Promise<void>`. Constructor accepts `BridgeInboundRequestOptions` which it passes to the engine (`authenticated-connection.ts:38-53`). `onRequest<M>()` delegates to the engine's inbound handler registration (`authenticated-connection.ts:85-90`).

### `ClientJsonRpcEngine` (`json-rpc-engine.ts:145-706`)

The RPC engine. Manages outbound pending requests, inbound adapter handlers, both completion-grace maps, role authorization, notifications, and socket lifecycle.

### `BridgeRequestOptions` (`json-rpc-engine.ts:49-52`)

```typescript
{ timeoutMs?: number; signal?: AbortSignal; }
```

### `BridgeInboundRequestOptions` (`json-rpc-engine.ts:54-57`)

```typescript
{ inboundRequestTimeoutMs?: number; maxInboundRequests?: number; }
```

Configuration for adapter-side inbound request handling. Consumed by `ClientJsonRpcEngine` constructor, `AuthenticatedBridgeConnection` constructor, `connectBridgeClient`, and `ReconnectingBridgeConnection`.

### `BridgeAdapterRequestContext<M>` (`json-rpc-engine.ts:59-63`)

```typescript
{
  id: JSONRPCRequestIdentifier;
  method: M;
  sessionId: SessionId;
  signal: AbortSignal;
}
```

Passed to adapter request handlers. `sessionId` comes from the accepted physical handshake and
rotates after reconnect; session-bound handles must use it. The `signal` is aborted on cancellation,
timeout, or socket close.

### `BridgeAdapterRequestHandler<M>` (`json-rpc-engine.ts:65-68`)

```typescript
(params: IDEBPRequestParams<M>, context: BridgeAdapterRequestContext<M>) =>
  IDEBPResponseResult<M> | Promise<IDEBPResponseResult<M>>;
```

Only adapter sessions may register one handler for each protocol-owned routed method.

### `BridgeNotificationHandler<M>` (`json-rpc-engine.ts:70-72`)

```typescript
(params: IDEBPNotificationParams<M>) => void | Promise<void>
```

### `PendingRequest` (`json-rpc-engine.ts:80-87`, internal)

```typescript
{
  method: IDEBPApplicationMethod;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}
```

### `LateResponse` (`json-rpc-engine.ts:89-92`, internal)

```typescript
{
  method: IDEBPApplicationMethod;
  expiration: ReturnType<typeof setTimeout>;
}
```

### `InboundRequest` (`json-rpc-engine.ts:94-98`, internal)

```typescript
{
  method: IDEBPRoutedMethod;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | undefined;
}
```

### `InboundCompletion` (`json-rpc-engine.ts:100-102`, internal)

```typescript
{
  expiration: ReturnType<typeof setTimeout>;
}
```

### `ReconnectingBridgeConnection` (`reconnecting-connection.ts:154-526`)

Logical lifetime facade exposing the same typed `request`, `notify`, `onRequest`, and `onNotification` operations plus cloned `state`, current `session`, `isConnected`, `onStateChange`, terminal `close`, and lifetime `closed`.

### `BridgeReconnectState` (`reconnecting-connection.ts:66-69`)

Discriminated union of `connected` with a cloned session, `reconnecting` with attempt and next delay, or terminal `closed`. It deliberately contains no discovery path, endpoint, token, or raw error.

### `BridgeReconnectOptions` (`reconnecting-connection.ts:54-61`)

```typescript
{
  reconnectInitialDelayMs?: number;    // Default 100ms
  reconnectMaxDelayMs?: number;         // Default 5000ms
  reconnectBackoffMultiplier?: number; // Default 2
  reconnectJitterRatio?: number;       // Default 0.2 (±20%)
  sessionRestoreTimeoutMs?: number;    // Default 30000ms
  restoreSession?: BridgeSessionRestorer;
}
```

### `BridgeSessionRestorer` (`reconnecting-connection.ts:49-52`)

```typescript
(connection: AuthenticatedBridgeConnection, context: BridgeSessionRestorationContext) => void | Promise<void>
```

Callback invoked after a new physical connection is established but before it is published as the current connection. Receives the attempt number, a `structuredClone` of the previous session, and an `AbortSignal`.

### `BridgeSessionRestorationContext` (`reconnecting-connection.ts:43-47`)

```typescript
{
  attempt: number;
  previousSession: AuthenticatedBridgeSession;
  signal: AbortSignal;
}
```

### Constants

| Constant                               | File:Line                       | Value                       | Purpose                                                                                 |
| -------------------------------------- | ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `DEFAULT_CLIENT_HANDSHAKE_TIMEOUT_MS`  | `connect.ts:37`                 | `4_000`                     | Default handshake timeout. Deliberately < server's 5s to ensure client times out first. |
| `MAX_CLIENT_HANDSHAKE_TIMEOUT_MS`      | `connect.ts:38`                 | `5_000`                     | Upper bound for handshake timeout.                                                      |
| `MAX_CLIENT_MESSAGE_BYTES`             | `connect.ts:39`                 | `10 * 1024 * 1024` (10 MiB) | WebSocket `maxPayload`.                                                                 |
| `DEFAULT_CLIENT_REQUEST_TIMEOUT_MS`    | `json-rpc-engine.ts:40`         | `30_000`                    | Default per-request timeout.                                                            |
| `MAX_CLIENT_REQUEST_TIMEOUT_MS`        | `json-rpc-engine.ts:41`         | `300_000`                   | Max per-request timeout (5 min).                                                        |
| `DEFAULT_INBOUND_REQUEST_TIMEOUT_MS`   | `json-rpc-engine.ts:42`         | `30_000`                    | Default inbound adapter-handler timeout.                                                |
| `MAX_INBOUND_REQUEST_TIMEOUT_MS`       | `json-rpc-engine.ts:43`         | `300_000`                   | Hard inbound handler timeout bound.                                                     |
| `DEFAULT_MAX_INBOUND_REQUESTS`         | `json-rpc-engine.ts:44`         | `128`                       | Default concurrent actual handler executions.                                           |
| `MAX_INBOUND_REQUESTS`                 | `json-rpc-engine.ts:45`         | `1_024`                     | Hard concurrent execution bound.                                                        |
| `LATE_RESPONSE_GRACE_MS`               | `json-rpc-engine.ts:46`         | `30_000`                    | Tombstone lifetime for late responses.                                                  |
| `MAX_LATE_RESPONSE_IDS`                | `json-rpc-engine.ts:47`         | `1_024`                     | Max tombstones; oldest evicted when full.                                               |
| `DEFAULT_RECONNECT_INITIAL_DELAY_MS`   | `reconnecting-connection.ts:34` | `100`                       | Initial reconnect backoff delay.                                                        |
| `DEFAULT_RECONNECT_MAX_DELAY_MS`       | `reconnecting-connection.ts:35` | `5_000`                     | Maximum reconnect backoff delay.                                                        |
| `DEFAULT_RECONNECT_BACKOFF_MULTIPLIER` | `reconnecting-connection.ts:36` | `2`                         | Exponential backoff multiplier.                                                         |
| `DEFAULT_RECONNECT_JITTER_RATIO`       | `reconnecting-connection.ts:37` | `0.2`                       | ±20% jitter on backoff delay.                                                           |
| `MAX_RECONNECT_DELAY_MS`               | `reconnecting-connection.ts:38` | `60_000`                    | Hard cap on any single delay value.                                                     |
| `MAX_RECONNECT_BACKOFF_MULTIPLIER`     | `reconnecting-connection.ts:39` | `10`                        | Hard cap on backoff multiplier.                                                         |
| `DEFAULT_SESSION_RESTORE_TIMEOUT_MS`   | `reconnecting-connection.ts:40` | `30_000`                    | Default session restoration timeout.                                                    |
| `MAX_SESSION_RESTORE_TIMEOUT_MS`       | `reconnecting-connection.ts:41` | `300_000`                   | Hard session restoration timeout bound.                                                 |

## Key Functions

### `connectBridgeClient(options): Promise<AuthenticatedBridgeConnection>` (`connect.ts:101-232`)

Main connection entry point. Validates discovery data, checks protocol version compatibility, validates handshake timeout bounds (1–5000ms), validates inbound request limits, builds a `BridgeHandshakeRequest`, opens a WebSocket with `followRedirects: false` and `perMessageDeflate: false`, sends the handshake, and waits for a valid response. On success, constructs and returns `AuthenticatedBridgeConnection` with inbound options. On failure (timeout, error, close, invalid response, rejection), rejects with the appropriate error.

### `connectBridgeClientFromDiscoveryFile(filePath, options): Promise<AuthenticatedBridgeConnection>` (`connect.ts:234-243`)

Convenience wrapper: reads a private discovery file via `readPrivateDiscoveryFile`, applies optional `endpointOverride`, then delegates to `connectBridgeClient`.

### `connectReconnectingBridgeClientFromDiscoveryFile(filePath, options)` (`reconnecting-connection.ts:528-538`)

Establishes one initial authenticated connection, then returns a logical facade. After physical loss it rereads discovery on every attempt, backs off with jitter, reattaches logical handlers, runs bounded session restoration, and atomically publishes the new session.

### `buildRequest(options): BridgeHandshakeRequest` (`connect.ts:80-99`, internal)

Constructs the handshake request object with `jsonrpc: "2.0"`, `method: "bridge/handshake"`, authentication token from discovery, role, protocol version range, cloned topology, and client info. Validates the result with `isBridgeHandshakeRequest`.

### `parseTextMessage(data, isBinary): unknown` (`connect.ts:62-70`, internal; duplicated in `json-rpc-engine.ts:123-131`)

Parses WebSocket `RawData` into a JSON value. Rejects binary frames. Handles `Buffer[]`, `ArrayBuffer`, and `Buffer` input shapes.

### `serializeCanonicalMessage(value, validate): string` (`json-rpc-engine.ts:133-143`, internal)

JSON-serializes a message after running the provided schema validator. Throws `BridgeClientConfigurationError` if validation or serialization fails.

### `ClientJsonRpcEngine.request(method, params, options): Promise<IDEBPResponseResult<M>>` (`json-rpc-engine.ts:199-274`)

Validates role authorization, timeout bounds, and pre-abort state, generates a unique request ID, serializes and schema-validates the request, registers a `PendingRequest` with timeout + abort handling, sends the message, and returns a promise that resolves on response or rejects on timeout/cancel/error/close.

### `ClientJsonRpcEngine.notify(method, params): Promise<void>` (`json-rpc-engine.ts:276-305`)

Sends a fire-and-forget notification (no `id`). Validates role authorization, checks socket is open, schema-validates via `classifyIDEBPNotification`, and sends it.

### `ClientJsonRpcEngine.onNotification(method, handler): () => void` (`json-rpc-engine.ts:307-329`)

Registers a notification handler for a specific method. Role-authorized only. Returns an unsubscribe function. Multiple handlers per method are supported via a `Set`.

### `ClientJsonRpcEngine.onRequest(method, handler): () => void` (`json-rpc-engine.ts:331-350`)

Registers an inbound adapter request handler for a routed method. Only adapter sessions may register; one handler per method. Returns an unsubscribe function.

### `ClientJsonRpcEngine.close(): Promise<void>` (`json-rpc-engine.ts:352-360`)

Closes the socket gracefully (code 1000) if open, or terminates if not yet open. Awaits the `closed` promise.

### `ClientJsonRpcEngine.#handleMessage(data, isBinary): void` (`json-rpc-engine.ts:370-423`, private)

Central message dispatcher. It distinguishes requests from notifications by the presence of `id`, validates their role and exact schema, dispatches inbound adapter requests, or settles an outbound pending response. Valid late responses and one crossed inbound cancellation are consumed through separate bounded grace maps.

### `ClientJsonRpcEngine.#handleIncomingRequest(value): void` (`json-rpc-engine.ts:425-501`, private)

Validates role, method schema, request ID uniqueness (against active and completed inbound), handler availability, and capacity. Creates an `AbortController` with a bounded timeout, reserves an execution slot, dispatches to the handler, and sends a validated success or normalized error response. First settlement wins through identity-checked `#takeInbound`.

### `ClientJsonRpcEngine.#handleIncomingNotification(value): void` (`json-rpc-engine.ts:503-535`, private)

Classifies the notification via `classifyIDEBPNotification`. For adapter role: only `$/cancelRequest` is accepted; it aborts the matching inbound request exactly once and sends a `CANCELLED` error. For consumer role: only consumer-inbound notification methods are dispatched.

### `ClientJsonRpcEngine.#createRequestId(): string` (`json-rpc-engine.ts:362-368`, private)

Generates `request_${base64url(randomBytes(18))}` in a uniqueness loop against both `#pending` and `#lateResponses`.

### `ClientJsonRpcEngine.#sendCancellationBestEffort(id): void` (`json-rpc-engine.ts:644-654`, private)

Sends `$/cancelRequest` notification for the given request ID. Failures are swallowed since the request is already settled locally.

### `ClientJsonRpcEngine.#rememberLateResponse(id, method): void` (`json-rpc-engine.ts:656-666`, private)

Adds a tombstone to `#lateResponses` with a 30s self-expiring timer. Evicts the oldest entry if at capacity (1024).

### `ClientJsonRpcEngine.#rememberInboundCompletion(id): void` (`json-rpc-engine.ts:620-630`, private)

Adds a completion tombstone to `#inboundCompletions` with a 30s self-expiring timer. Evicts the oldest entry if at capacity (1024). Prevents duplicate handling of a crossed late cancellation.

### `ClientJsonRpcEngine.#protocolViolation(): void` (`json-rpc-engine.ts:680-692`, private)

Rejects all pending requests, aborts all inbound, clears completions and late responses, then closes the socket with code 1002 (protocol error) or terminates.

### `ClientJsonRpcEngine.#rejectAll(error): void` (`json-rpc-engine.ts:701-706`, private)

Iterates a snapshot of all pending request IDs, removes each from the map, clears its timeout and abort listener, and rejects with the given error.

### `ReconnectingBridgeConnection.#monitor(connection, generation): Promise<void>` (`reconnecting-connection.ts:321-330`, private)

Awaits the physical connection's `closed` promise. On close, checks generation and current-connection identity to prevent stale monitors from triggering reconnection.

### `ReconnectingBridgeConnection.#reconnect(previousSession): Promise<void>` (`reconnecting-connection.ts:332-379`, private)

Retry loop with exponential backoff and jitter. Rereads discovery, authenticates, attaches handlers, runs session restoration, and atomically publishes the new generation. On failure, detaches and closes the candidate, then retries.

### `ReconnectingBridgeConnection.#restore(connection, previousSession, attempt): Promise<void>` (`reconnecting-connection.ts:381-431`, private)

Runs the `restoreSession` callback with a timeout via `Promise.race`. Aborts on lifecycle abort or timeout. The previous session is passed as a `structuredClone`.

### `ReconnectingBridgeConnection.#jitteredDelay(baseDelayMs): number` (`reconnecting-connection.ts:433-437`, private)

Applies ±jitterRatio jitter to the base delay, clamped to `[1, maxDelayMs]`.

### `reconnectSettings(options): ReconnectSettings` (`reconnecting-connection.ts:103-129`, internal)

Validates and normalizes all reconnect options. Throws `BridgeClientConfigurationError` if any value is out of bounds.

### `connectionOptions(options): ConnectBridgeClientFromDiscoveryFileOptions` (`reconnecting-connection.ts:131-152`, internal)

Extracts and clones connection options (topology, clientInfo, endpoint override, timeouts, inbound limits) from the reconnecting options, omitting reconnect-specific fields and the `signal`.

## Data & Control Flow

### Connection Establishment

```
connectBridgeClient(options)
  ├─ parseIDEBPDiscoveryFile(options.discovery)          ← validate discovery data
  ├─ check discovery.protocolVersion === PROTOCOL_VERSION
  ├─ validate handshakeTimeoutMs ∈ [1, 5000]
  ├─ validate inboundRequestTimeoutMs ∈ [1, 300000]
  ├─ validate maxInboundRequests ∈ [1, 1024]
  ├─ buildRequest(options)                               ← construct handshake JSON-RPC
  │    └─ isBridgeHandshakeRequest(request)              ← schema validate
  └─ new Promise<AuthenticatedBridgeConnection>
       ├─ new WebSocket(endpoint, { followRedirects: false, perMessageDeflate: false, ... })
       ├─ setTimeout(handshakeTimeoutMs)                  ← unref'd
       ├─ socket.on("open") → socket.send(handshakeRequest)
       ├─ socket.on("message") → parseTextMessage → classifyBridgeHandshakeServerMessage
       │    ├─ invalid / wrong id  → reject(ProtocolViolationError)
       │    ├─ kind === "error"    → reject(BridgeHandshakeRejectedError)
       │    └─ kind === "success"  → validate role + protocolVersion match
       │         └─ resolve(new AuthenticatedBridgeConnection(socket, result, { inboundRequestTimeoutMs, maxInboundRequests }))
       ├─ socket.on("error")   → reject(ConnectionError)
       └─ socket.on("close")    → reject(ConnectionError)
```

### Outbound Request Lifecycle

```
connection.request(method, params, options)
  └─ engine.request(method, params, options)
       ├─ validate role authorization (adapter-originated vs consumer-originated)
       ├─ validate timeoutMs ∈ [1, 300000]
       ├─ check signal.aborted, socket.readyState === OPEN
       ├─ #createRequestId()                          ← unique against pending + late
       ├─ serializeCanonicalMessage(request, isIDEBPApplicationRequest)
       ├─ register PendingRequest { timeout, signal, onAbort, resolve, reject }
       ├─ socket.send(serialized)
       │
       │  ── meanwhile ──
       ├─ socket.on("message") → #handleMessage
       │    ├─ has method + id → inbound adapter request dispatch
       │    ├─ has method only → role-authorized notification dispatch
       │    └─ has id only:
       │         ├─ pending exists → resolve/reject + cleanup
       │         ├─ late response exists → validate + forget tombstone
       │         └─ unknown id → protocol violation
       │
       ├─ timeout fires → #takePending + #rememberLateResponse + #sendCancellationBestEffort
       │                   → reject(RequestTimeoutError)
       ├─ signal.abort  → same as timeout → reject(RequestCancelledError)
       └─ socket close  → #rejectAll(ConnectionError) + #abortAllInbound + #clearInboundCompletions + #clearLateResponses
```

### Inbound Adapter Request Flow

```
Daemon sends routed request
  └─ #handleIncomingRequest
       ├─ validate role === adapter, method is routed, schema, request ID uniqueness
       ├─ check handler registered; if not → CAPABILITY_UNAVAILABLE error
       ├─ check capacity; if at max → PRECONDITION_FAILED error
       ├─ create AbortController + bounded timeout; reserve execution slot
       ├─ handler(params, { id, method, signal })
       ├─ first settlement wins through identity-checked #takeInbound
       ├─ validate exact method result → #sendInboundSuccess
       │   or catch BridgeAdapterRequestError → #sendInboundError with error.data
       │   or catch other error → #sendInboundError with PROVIDER_FAILED
       └─ release execution slot in .finally()
```

### Inbound Cancellation Flow

```
Daemon sends $/cancelRequest notification
  └─ #handleIncomingNotification
       ├─ classifyIDEBPNotification → must be "$/cancelRequest"
       ├─ extract id from params
       ├─ #takeInbound(id) → if found:
       │    ├─ abort controller
       │    ├─ #rememberInboundCompletion(id)
       │    └─ #sendInboundError(id, { code: "CANCELLED", retryable: false })
       ├─ if not found but in #inboundCompletions → forget completion (absorb crossed cancel)
       └─ dispatch to $/cancelRequest notification handlers
```

### Notification Flow

```
Daemon sends notification
  └─ socket.on("message") → #handleMessage
       └─ classifyIDEBPNotification(value)
            ├─ enforce session-role direction
            ├─ adapter: only $/cancelRequest accepted
            └─ consumer: only CONSUMER_INBOUND_NOTIFICATION_METHODS dispatched
            └─ dispatch to handler Set via Promise.resolve().catch(swallow)
```

### Reconnection Flow

```
physical connection closes
  ├─ #monitor detects close (generation-checked)
  ├─ detach generation handlers from the closed connection
  ├─ transition reconnecting(attempt, delay)
  ├─ #waitForRetry with capped exponential backoff + jitter (cancellable)
  ├─ reread and validate private discovery file
  ├─ authenticate a new physical session
  ├─ attach persistent request/notification handlers
  ├─ run bounded restoreSession(candidate, previousSession, signal)
  ├─ increment generation, publish connected only if candidate remains open
  └─ new #monitor for the new generation
```

## Integration Points

- **Consumed by**: `packages/bridge-client/src/index.ts` (barrel re-exports), `@ide-bridge/conformance` (integration tests).
- **Depends on**:
  - `@ide-bridge/protocol` — `PROTOCOL_VERSION`, `parseIDEBPDiscoveryFile`, `classifyBridgeHandshakeServerMessage`, `isBridgeHandshakeRequest`, `isIDEBPApplicationRequest`, `isIDEBPApplicationResponse`, `isIDEBPJSONRPCErrorResponse`, `isJSONRPCRequestIdentifier`, `classifyIDEBPNotification`, `isIDEBPNotificationMethod`, `IDEBP_ROUTED_METHODS`, `IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS`, `IDEBP_ADAPTER_ORIGINATED_METHODS`, `IDEBP_CONSUMER_LOCAL_METHODS`, `IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS`, and all IDEBP type definitions.
  - `ws` — `WebSocket`, `RawData`.
  - `node:crypto` — `randomBytes` for request ID generation.
  - `../discovery/discovery-file.js` — `readPrivateDiscoveryFile` (used by `connectBridgeClientFromDiscoveryFile`).
  - `../errors.js` — all error classes including `BridgeClientReconnectingError` and `BridgeAdapterRequestError`.
  - `../metadata.js` — `CLIENT_NAME`, `CLIENT_VERSION`.
- **External boundaries**:
  - WebSocket endpoint URI from `IDEBPDiscoveryFile.endpoint` (loopback only per security rules).
  - Handshake timeout and max payload are configurable but bounded by constants.
  - Inbound request timeout and concurrency are configurable but bounded by constants.

## Common Gotchas

- **Client handshake timeout (4s) is deliberately shorter than the server's (5s)**. This ensures the client rejects first, avoiding a race where the server's timeout fires while the client is still waiting. Do not increase `DEFAULT_CLIENT_HANDSHAKE_TIMEOUT_MS` beyond 5s (`connect.ts:37-38`).
- **`followRedirects: false` and `perMessageDeflate: false`** are hardcoded on the WebSocket constructor. The client will not follow HTTP redirects and will not use compression. This is a security and simplicity choice (`connect.ts:149, 152`).
- **Request IDs are direction-scoped but guarded through completion grace**. Outbound IDs are unique against pending/late-response state; inbound route IDs are unique against active/completed state (`json-rpc-engine.ts:362-368, 425-440`).
- **Late-response tombstones have a 30s grace period and are capped at 1024 entries**. When full, the oldest entry (insertion-order) is evicted. Tombstones self-expire via an `unref`'d timer, so they do not keep the process alive (`json-rpc-engine.ts:46-47, 656-666`).
- **Inbound completion tombstones also have a 30s grace and 1024 cap**. They absorb exactly one crossed late cancellation per ID. After the tombstone is consumed or expires, a duplicate cancellation for the same ID is a protocol violation (`json-rpc-engine.ts:620-642`).
- **Notification handlers are async-safe but errors are swallowed**. A throwing or rejecting handler will not crash the engine or affect other handlers (`json-rpc-engine.ts:537-543`).
- **Inbound cancellation is cooperative**. Timeout/cancellation aborts the handler signal and settles the wire request, but synchronous JavaScript cannot be preempted. The actual handler keeps its capacity slot until its promise settles (`json-rpc-engine.ts:452-500`).
- **Reconnection never replays calls**. Applications must explicitly retry only operations they know are safe; old plans, undo tokens, handles, and IDs remain invalid (`reconnecting-connection.ts:315-319`).
- **Adapter restoration must use current IDE state**. Do not cache the initial `ide/register` request as a substitute for rebuilding workspaces, trust, and capabilities (`reconnecting-connection.ts:381-431`).
- **Endpoint overrides never replace discovery authentication**. `endpointOverride` exists only on private discovery-file connection APIs. The file is validated and reread on every reconnect; only its loopback endpoint is replaced before the complete discovery object is validated again (`connect.ts:234-243`).
- **Heartbeat needs no client application timer**. The `ws` stack automatically returns pong control frames; `ide/ping` is not scheduled by the shared client.
- **`parseTextMessage` is duplicated** in `connect.ts:62-70` and `json-rpc-engine.ts:123-131`. Both reject binary frames and handle the same `RawData` shapes. This is intentional to keep the handshake and engine paths independent.
- **`timeout.unref()`** is called on all timers (handshake timeout, request timeouts, late-response expirations, inbound timeouts, inbound completion expirations, reconnect delays, session restore timeout) so they do not keep the Node.js event loop alive (`connect.ts:159`, `json-rpc-engine.ts:251, 468, 628, 664`, `reconnecting-connection.ts:401, 453`).
- **`socket.on("error", () => undefined)` during handshake** silently swallows the `error` event because the actual error is surfaced via `close` or the explicit `onError` handler. Without this, Node would throw an unhandled error event (`connect.ts:154`).
- **`session` getter returns a `structuredClone`**, so mutating the returned object does not affect the internal state. `daemonTopology` is also cloned at construction time (`authenticated-connection.ts:50, 56`).
- **`close()` on a non-OPEN, non-CLOSED socket calls `terminate()`** rather than `close()`, because the WebSocket close handshake requires an OPEN state (`json-rpc-engine.ts:352-360`).
- **Protocol violations are terminal** — `#protocolViolation` rejects ALL pending requests, aborts ALL inbound, clears completions and late responses, then closes/terminates the socket. There is no recovery path; the connection must be re-established (`json-rpc-engine.ts:680-692`).
- **On socket close, all inbound is aborted and all grace maps are cleared**. The `close` handler in the constructor calls `#rejectAll`, `#abortAllInbound`, `#clearInboundCompletions`, and `#clearLateResponses` (`json-rpc-engine.ts:182-190`).
- **Generation tracking prevents stale reconnection monitors**. Each new connection increments `#generation`; the `#monitor` for a previous generation returns immediately if the generation has moved on (`reconnecting-connection.ts:321-330, 359-362`).
- **`structuredClone` is used for state, session, and topology** to prevent callers from mutating internal state through returned references (`reconnecting-connection.ts:194, 414, 519-522`, `authenticated-connection.ts:50, 56`).
- **`#usableConnection` rejects immediately during reconnection** with `BridgeClientReconnectingError` — requests are NOT queued (`reconnecting-connection.ts:315-319`).
