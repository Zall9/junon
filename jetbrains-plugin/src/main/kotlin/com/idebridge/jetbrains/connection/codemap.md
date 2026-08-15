# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/connection/

## Responsibility
Establishes and maintains the authenticated WebSocket connection from the JetBrains adapter to the IDE Bridge daemon, and routes incoming JSON-RPC requests to the adapter's handler methods. Five files cover the full client lifecycle: reading and validating the daemon's discovery file (`DiscoveryReader`), performing the authenticated `bridge/handshake` exchange (`HandshakeClient`), issuing correlated JSON-RPC request/response calls over the established session (`RpcClient`), providing the underlying loopback WebSocket transport (`WebSocketTransport`), and dispatching daemon-forwarded requests to the adapter's `Backend` implementation (`AdapterRouter`). This is the JetBrains-side counterpart to `packages/bridge-client/src/` in the TypeScript monorepo.

## Design Patterns
- **Sealed Outcome Interfaces**: Every public operation returns a `sealed interface Outcome` with success/failure variants, forcing exhaustive `when` handling at call sites. `DiscoveryReader.Outcome` (DiscoveryReader.kt:26-31), `HandshakeClient.Outcome` (HandshakeClient.kt:40-49), `RpcClient.Outcome<N>` (RpcClient.kt:29-36).
- **Error-First Parsing**: Both `HandshakeClient` and `RpcClient` attempt to decode the error shape before the success shape, because a refusal is a valid, expected answer — not an exception. HandshakeClient.kt:81-89, RpcClient.kt:66-78.
- **Transport Abstraction**: `HandshakeClient.Transport` interface (HandshakeClient.kt:31-38) decouples message exchange from the network, making handshake and RPC logic testable without a socket. `WebSocketTransport` is the sole production implementation.
- **Symlink Defense**: `DiscoveryReader` uses `LinkOption.NOFOLLOW_LINKS` on every file check (DiscoveryReader.kt:45-50, 69-70) so a symlinked discovery file cannot redirect the plugin to an attacker's endpoint.
- **Error Swallowing for Security**: `DiscoveryReader.read()` deliberately catches and discards parse exceptions (DiscoveryReader.kt:55-58) because a parse error message can echo file content — including the token.
- **Loopback Triple-Check**: The endpoint is validated as loopback in `DiscoveryReader` before use, and `WebSocketTransport.connect()` re-validates via `require(DiscoveryReader.isLoopbackEndpoint(endpoint))` (WebSocketTransport.kt:61) so the transport cannot be pointed elsewhere even if the file were tampered after reading.
- **Blocking Synchronous API**: `HandshakeClient.connect()` and `RpcClient.call()` are synchronous/blocking by design; callers are responsible for running them off the EDT (AGENTS.md §3).
- **Platform-Free Routing**: `AdapterRouter` contains no platform types. The `Backend` interface is what touches the IDE, so routing, decoding, and refusals are exercised without one (AdapterRouter.kt:36-42). Only methods the adapter genuinely implements are routed; anything else falls through to `RpcClient.Answer.Unsupported`, which answers `CAPABILITY_UNAVAILABLE` — the same thing the registration declares, so what the adapter advertises and what it does cannot drift apart (AdapterRouter.kt:39-42, 290).
- **Sealed Outcome for Refactor/Apply/Hierarchy**: `AdapterRouter` defines `RenameOutcome`, `ApplyOutcome`, and `HierarchyOutcome` as sealed interfaces so the `when` in `handle()` is exhaustive and a refusal carries a protocol `ErrorCode` the consumer can act on (AdapterRouter.kt:106-128).
- **Exception Isolation**: A backend that throws answers `PROVIDER_FAILED` rather than propagating. The session-level handler would report it as `INTERNAL_ERROR`, which says the adapter is broken when in fact one provider is. The exception is logged (not discarded) but the wire answer stays `PROVIDER_FAILED` — an exception's message can carry file text (AdapterRouter.kt:300-319).

## Key Types
- `DiscoveryReader` (DiscoveryReader.kt:18) — `object`. Stateless reader/validator for the daemon discovery file. Holds `MAX_DISCOVERY_BYTES = 4096` (line 20) and `LOOPBACK_ENDPOINT` regex (lines 23-24).
  - `Outcome` (line 26): `Ready(discovery: DiscoveryFile)` | `Unusable(reason: Reason)`.
  - `Reason` (lines 33-40): `MISSING`, `NOT_A_REGULAR_FILE`, `TOO_LARGE`, `PERMISSIONS_TOO_OPEN`, `MALFORMED`, `ENDPOINT_NOT_LOOPBACK`.
- `HandshakeClient` (HandshakeClient.kt:26-29) — `class`. Holds `clientInfo: PeerInfo` and `supportedProtocol: ProtocolRange` (defaults to single-point `"0.1.0".."0.1.0"`).
  - `Transport` (line 31): `send(message: String)`, `receive(): String?`, `close()`.
  - `Outcome` (line 40): `Established(session: HandshakeResult)` | `Refused(code: ErrorCode, supportedProtocol: ProtocolRange?)` | `Failed(reason: Reason)`.
  - `Reason` (lines 51-57): `NO_RESPONSE`, `MALFORMED_RESPONSE`, `IDENTIFIER_MISMATCH`, `ROLE_MISMATCH`, `UNSUPPORTED_VERSION`.
- `RpcClient` (RpcClient.kt:23-26) — `class`. Holds `transport: HandshakeClient.Transport`, `onNotification` callback, `nextId: AtomicLong(1)`.
  - `Outcome<R>` (line 29): `Ok<R>(result: R)` | `Failed(code: ErrorCode, retryable: Boolean)` | `Broken(reason: Reason)`.
  - `Reason` (lines 38-42): `NO_RESPONSE`, `MALFORMED_RESPONSE`, `IDENTIFIER_MISMATCH`.
- `WebSocketTransport` (WebSocketTransport.kt:20-24) — `class`, private constructor. Implements `HandshakeClient.Transport`. Holds `socket: WebSocket`, `inbound: LinkedBlockingQueue<Message>`, `receiveTimeout: Duration`.
  - `Message` (line 26): `Text(value: String)` | `Closed` (data object).
  - `Listener` (line 81): private inner `class : WebSocket.Listener`. Bridges async JDK callbacks to the synchronous `receive()` via `LinkedBlockingQueue`. Performs partial-frame reassembly (line 82, `partial: StringBuilder`).
  - `MAX_MESSAGE_BYTES = 10 * 1024 * 1024` (line 54) — 10 MiB, matching the daemon's frame ceiling.
- `AdapterRouter` (AdapterRouter.kt:43) — `class`. Implements `RpcClient.RequestHandler`. Holds `backend: Backend`. Routes 19 method strings to `Backend` calls via a `when` expression (lines 165-291).
  - `Backend` (interface, `:52-103`) — What the adapter can actually answer: `documentSymbols`, `searchSymbols`, `documentRead`, `documentRevision`, `diagnostics`, `prepareRename`, `locations`, `hierarchy`, `searchTodos` (`:87`), `listBookmarks` (`:90-92`), `resolveAt`, `prepare`, `applyPlan`, `discardPlan`, `undo`. `null` means the target is not this adapter's to answer for, which becomes a not-found rather than an empty result.
  - `RenameOutcome` (sealed, `:106-110`): `Prepared(result: RefactorPrepareRenameResult)` | `Refused(code: ErrorCode)`.
  - `ApplyOutcome` (sealed, `:112-116`): `Applied(result: ModificationResult)` | `Refused(code: ErrorCode)`.
  - `HierarchyOutcome` (sealed, `:124-128`): `Found(result: SymbolLocationsResult)` | `Unsupported` (the relation has no language-neutral engine behind it — stated rather than approximated as an empty list).
  - `IMPLEMENTED_METHODS` (companion, `:326-344`) — The 19 methods this router serves; the registration announces exactly these as supported. Added `workspace/searchTodos` and `workspace/listBookmarks` beyond the original 17.

## Key Functions
- `DiscoveryReader.read(path: Path): Outcome` (DiscoveryReader.kt:42) — Reads, permission-checks, parses, and loopback-validates the discovery file. Returns `Ready` or `Unusable` with a specific `Reason`. Never leaks file content in failure paths.
- `DiscoveryReader.hasPrivatePermissions(path: Path): Boolean` (DiscoveryReader.kt:66) — Returns true when no group or other bits are set. Non-POSIX filesystems return `true` (cannot check, line 71).
- `DiscoveryReader.isLoopbackEndpoint(endpoint: String): Boolean` (DiscoveryReader.kt:84) — Regex-matches `ws://127.0.0.1:<port>/rpc` or `ws://[::1]:<port>/rpc` and validates port range 1..65535. Public so `WebSocketTransport` can re-check.
- `HandshakeClient.connect(transport, discovery, role, topology, requestId): Outcome` (HandshakeClient.kt:59) — Sends `bridge/handshake`, receives the reply, error-first parses, checks correlation ID (line 93), role (line 94), and protocol version (line 95). Returns `Established`, `Refused`, or `Failed`.
- `HandshakeClient.isSupported(selected: String): Boolean` (HandshakeClient.kt:105) — Private. Returns true when the daemon's selected version equals either bound of the offered range. Currently a single-point range, so this is equality with `"0.1.0"`.
- `RpcClient.call(method, params, paramsSerializer, resultSerializer): Outcome<R>` (RpcClient.kt:44) — Sends a `Request` with ID `"jb-N"` (line 50), then loops receiving messages: notifications are delivered to the callback and skipped (lines 60-64); error responses and success responses are matched by ID. Any ID mismatch is `Broken(IDENTIFIER_MISMATCH)`, not a late answer.
- `RpcClient.notify(method, params, paramsSerializer)` (RpcClient.kt:82) — Sends a `Notification` (no `id` field). Fire-and-forget.
- `RpcClient.notificationMethodOrNull(raw: String): String?` (RpcClient.kt:90) — Private. Parses raw JSON, returns the `method` string when the message has `method` and no `id`, else `null`.
- `WebSocketTransport.connect(endpoint, connectTimeout, receiveTimeout): WebSocketTransport` (WebSocketTransport.kt:56) — Factory. Requires loopback (line 61), builds `HttpClient` with `Redirect.NEVER` (line 67), connects via `buildAsync` with the `Listener` (line 71).
- `WebSocketTransport.send(message: String)` (WebSocketTransport.kt:32) — Size-checks outbound (line 33), sends as a final text frame, blocks via `.join()`.
- `WebSocketTransport.receive(): String?` (WebSocketTransport.kt:39) — Blocks on `inbound.poll(timeout)`. Returns `null` on timeout or `Closed`.
- `WebSocketTransport.close()` (WebSocketTransport.kt:47) — Sends a normal closure frame, then aborts the socket. Both wrapped in `runCatching` so closing is idempotent.
- `Listener.onText(webSocket, data, last)` (WebSocketTransport.kt:88) — Accumulates partial frames in `partial` (line 93), enforces size ceiling (line 94), puts complete message on `last` (line 101), requests next frame (line 104).
- `Listener.onBinary(webSocket, data, last)` (WebSocketTransport.kt:109) — Aborts the socket and puts `Closed`. Binary frames are not part of the contract.
- `AdapterRouter.handle(method: String, raw: String): RpcClient.Answer` (AdapterRouter.kt:165-291) — Routes 19 method strings to `Backend` calls. Unrouted methods return `RpcClient.Answer.Unsupported` (→ `CAPABILITY_UNAVAILABLE`). Each route decodes params, delegates to the backend, and encodes the result or maps `null` to `WORKSPACE_NOT_FOUND` / `DOCUMENT_NOT_FOUND` / `PLAN_NOT_FOUND` as appropriate. New routes: `workspace/searchTodos` (`:232-236`) → `backend.searchTodos(params)`; `workspace/listBookmarks` (`:238-242`) → `backend.listBookmarks(params)`.
- `AdapterRouter.route(raw, serializer, answer): RpcClient.Answer` (AdapterRouter.kt:300-319, private) — Decodes `Request<P>` via `IdebpJson`, then delegates to `answer(params)`. A decode failure returns `INVALID_REQUEST`. A throw from the backend is logged and answered `PROVIDER_FAILED` (not propagated — see Exception Isolation above).
- `AdapterRouter.encode(serializer, value): RpcClient.Answer` (AdapterRouter.kt:321-322, private) — Wraps a result as `RpcClient.Answer.Result(IdebpJson.encodeToJsonElement(...))`.

## Data & Control Flow
1. **Discovery**: `DiscoveryReader.read(path)` → file existence/size/permission/parse/loopback checks → `Outcome.Ready(DiscoveryFile)` containing `endpoint`, `token`, `pid`, `startedAt`.
2. **Transport**: `WebSocketTransport.connect(endpoint)` → JDK `HttpClient` opens a WebSocket to `ws://127.0.0.1:<port>/rpc` → `Listener` callbacks feed `LinkedBlockingQueue<Message>` → synchronous `send()`/`receive()` bridge.
3. **Handshake**: `HandshakeClient.connect(transport, discovery, role, topology, requestId)` → encodes `HandshakeRequest` with `HandshakeAuthentication(token = discovery.token)` → `transport.send()` → `transport.receive()` → error-first parse → correlation/role/version checks → `Outcome.Established(HandshakeResult)` with `sessionId`.
4. **RPC (outbound)**: `RpcClient.call(method, params, ...)` → encodes `Request` with `id = "jb-N"` → `transport.send()` → `while(true)` loop: `transport.receive()` → if notification, deliver to `onNotification` callback and continue; if error response, return `Failed`; if success response with matching ID, return `Ok(result)`. Any ID mismatch returns `Broken(IDENTIFIER_MISMATCH)`.
5. **RPC (inbound routing)**: Daemon forwards a consumer's request → `RpcClient.serve()` delivers it to `AdapterRouter.handle(method, raw)` (`:165-291`) → `route()` decodes params via `IdebpJson` → delegates to `backend.<method>(params)` → `Backend` returns a result DTO, `null` (not this workspace), or a sealed outcome (`RenameOutcome`, `ApplyOutcome`, `HierarchyOutcome`) → `handle()` encodes the result or maps the refusal to `RpcClient.Answer.Failed(ErrorCode)`. Unrouted methods → `Answer.Unsupported` (`:290`) → `CAPABILITY_UNAVAILABLE`. A throw → logged → `Answer.Failed(PROVIDER_FAILED)`.

## Integration Points
- **Consumed by**: `com.idebridge.jetbrains.service.BridgeDaemonConnectionService` (service layer) — orchestrates discovery → transport → handshake → RPC. Constructs `AdapterRouter(backend)` and passes it as `RpcClient`'s `onRequest` handler (BridgeDaemonConnectionService.kt:175).
- **Depends on**: `com.idebridge.jetbrains.protocol` — `DiscoveryFile`, `IdebpJson`, all handshake/RPC/error/notification types, all request/response DTOs for routed methods. JDK `java.net.http.HttpClient` / `WebSocket` (no external WebSocket dependency). `kotlinx.serialization` for JSON codec. `java.util.concurrent` (`AtomicLong`, `LinkedBlockingQueue`). `com.intellij.openapi.diagnostic.logger` (for logging routed request failures, AdapterRouter.kt:315).
- **External boundaries**: 
  - Discovery file path — supplied by the service layer, typically `~/.ide-bridge/discovery.json` or via `IDE_BRIDGE_DISCOVERY_FILE` env var.
  - WebSocket endpoint — `ws://127.0.0.1:<port>/rpc` or `ws://[::1]:<port>/rpc`, loopback only.
  - No env vars read directly; the token comes from the discovery file.

## Common Gotchas
- **`Unusable` carries no file content** — by design. A failure must not become a way to leak the token (DiscoveryReader.kt:29-30). Do not add the raw content or parse error to `Reason`.
- **Symlink defense is mandatory** — every `Files` call must use `LinkOption.NOFOLLOW_LINKS`. A symlinked discovery file would let another user redirect this plugin at an endpoint of their choosing (DiscoveryReader.kt:44-48).
- **`isLoopbackEndpoint` is called twice** — once in `DiscoveryReader.read()` (line 59) and again in `WebSocketTransport.connect()` (line 61). This is intentional defense-in-depth, not redundant code.
- **Error-first parsing order matters** — `HandshakeErrorResponse` must be attempted before `HandshakeResponse` (HandshakeClient.kt:81-89). A refusal is a valid answer, and the success shape may partially match the error shape. Same in `RpcClient` (lines 66-78).
- **ID mismatch is `Broken`, not a late answer** — A response carrying a different identifier is a protocol violation, not a delayed reply to reinterpret (RpcClient.kt:69, 77). Never "wait for the right ID" — the session is broken.
- **Notifications can interleave at any time** — The `while(true)` loop in `RpcClient.call()` must deliver notifications to the handler and continue, not discard them (RpcClient.kt:60-64). The daemon may push events between a request and its response.
- **`WebSocketTransport.Listener.onText` reassembles partial frames** — The JDK delivers a message in pieces. Treating a piece as a complete message would hand malformed JSON to the protocol layer (WebSocketTransport.kt:82-105). The `partial` accumulator must be reset on `last` (line 102).
- **Binary frames end the connection** — `onBinary` aborts the socket and puts `Closed` (WebSocketTransport.kt:109-117). The contract is text-only.
- **`Redirect.NEVER` is a security requirement** — A redirect would move the connection off the loopback endpoint the discovery file authorised (WebSocketTransport.kt:67). Never change this.
- **`hasPrivatePermissions` returns `true` on non-POSIX filesystems** — It cannot check, so it allows. This is the correct default (DiscoveryReader.kt:71). On macOS/Linux it enforces `0600`.
- **All calls are blocking** — `receive()` blocks on the queue. `HandshakeClient.connect()` and `RpcClient.call()` must never be called on the EDT (AGENTS.md §3). The service layer is responsible for thread management.
- **Unrouted methods return `Unsupported`, not an error** — An unrouted method becomes `CAPABILITY_UNAVAILABLE`, which is what the registration already declared. This keeps what the adapter advertises and what it does from drifting apart (AdapterRouter.kt:290).
- **`null` from `Backend` is not-found, not empty** — A backend returning `null` means the workspace/document is not this adapter's to answer for. The router maps it to `WORKSPACE_NOT_FOUND` or `DOCUMENT_NOT_FOUND`, never to an empty result (AdapterRouter.kt:168, 182, 194, 207, 216, 235, 241, 247).
- **`HierarchyOutcome.Unsupported` is not an empty list** — A relation with no engine behind it is refused as `CAPABILITY_UNAVAILABLE`, not returned as zero results. An empty list would read as "nothing found" and be believed (AdapterRouter.kt:224-225).
- **A thrown exception is logged, not propagated** — The wire answer is `PROVIDER_FAILED`; the exception's message can carry file text and must not travel. The IDE's own log is where the adapter author sees what broke (AdapterRouter.kt:309-318).
- **`IMPLEMENTED_METHODS` and `handle()` must agree** — The registration announces exactly `IMPLEMENTED_METHODS` as supported. Adding a route in `handle()` without adding it to `IMPLEMENTED_METHODS` (or vice versa) would make the adapter advertise and serve different things (AdapterRouter.kt:326-344).
