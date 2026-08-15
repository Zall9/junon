# packages/bridge-daemon/src/

## Responsibility

Top-level daemon source package. Composes the WebSocket transport, session registry, application router, in-memory edit plan store, and redacted structured logger into a single `IDEBPDaemonServer` orchestrator, and re-exports all public modules via `index.ts`. Provides daemon identity constants (`DAEMON_NAME`, `DAEMON_VERSION`). The daemon acts as a loopback-only JSON-RPC 2.0 broker between IDE adapters (JetBrains/VS Code) and consumers (Serena/clients).

## Design Patterns

- **Facade / Orchestrator**: `IDEBPDaemonServer` (`daemon-server.ts:26`) composes `SessionRegistry`, `ApplicationRouter`, `LoopbackWebSocketServer`, a `StructuredLogger`, and optionally a `DashboardServer`. All transport lifecycle callbacks wire into the logger for redacted observability.
- **Deny-by-default observability**: only session/request correlation metadata and canonical enums cross into `StructuredLogger`; authenticated payloads and raw errors do not. The logger defaults to `"silent"` (`daemon-server.ts:43`) so library embedders receive no unsolicited stderr.
- **Barrel Export**: `index.ts:10-21` re-exports all submodules using `export * from` with `.js` extensions (NodeNext ESM).
- **Dependency Injection**: `IDEBPDaemonServerOptions` (`daemon-server.ts:14`) extends `ApplicationRouterOptions` and passes options through to each composed component. `now`, `createSessionId`, `handshakeTimeoutMs`, `maxMessageBytes`, `heartbeatIntervalMs`, `maxMissedHeartbeats`, and `logger` are all injectable for testing.
- **ID Remapping**: Consumer request IDs are replaced with route IDs by the router; adapter responses are remapped back. See routing codemap.
- **In-Memory Plan Store**: `InMemoryEditStore` (in `plan/`) manages edit plans and undo tokens with TTL-based sweeping, per-consumer capacity limits, and `structuredClone` on all returns.

## Key Types

- `IDEBPDaemonServerOptions` (`daemon-server.ts:15`): extends `ApplicationRouterOptions` with `expectedToken`, `supportedProtocolVersions?`, `createSessionId?`, `handshakeTimeoutMs?`, `maxMessageBytes?`, `heartbeatIntervalMs?`, `maxMissedHeartbeats?`, `logger?: StructuredLogger`.
- `IDEBPDaemonServer` (`daemon-server.ts:26`): Implements `ServerTransport`. Exposes `registry: SessionRegistry`, `router: ApplicationRouter` as public readonly fields; `#dashboard: DashboardServer | undefined` (`:37`), `#transport: LoopbackWebSocketServer` and `#logger: StructuredLogger` are private.
- `DAEMON_NAME` (`metadata.ts:1`): `"ide-bridge-daemon"` (const).
- `DAEMON_VERSION` (`metadata.ts:2`): `"0.0.0"` (const).
- `RpcLogMetadata` (`daemon-server.ts:161-165`): `{ sessionId: SessionId; requestId?: JSONRPCRequestIdentifier; method?: string }` — extracted by `rpcLogMetadata` for correlation logging.

## Key Functions

- `IDEBPDaemonServer.start()` (`daemon-server.ts:133`): Delegates to `#transport.start()`, sets `#running = true`, logs `daemon.started`, returns the `ws://127.0.0.1:<port>/rpc` endpoint string.
- `IDEBPDaemonServer.startDashboard()` (`daemon-server.ts:115-127`): Constructs a `DashboardServer` with a snapshot assembled from `router.status()` (includes metrics), `registry.listAdapters()`, and `registry.listWorkspaces()`. Returns `{ endpoint, url }` where `url` includes the single-use launch token. Off unless asked for (ADR-0035).
- `IDEBPDaemonServer.dashboardEndpoint` getter (`daemon-server.ts:129-131`): Returns the dashboard HTTP endpoint or `undefined` if not started.
- `IDEBPDaemonServer.close()` (`daemon-server.ts:144`): Delegates to `#transport.close()` in a `try/finally`; sets `#running = false`, closes the dashboard (`:150-151`), calls `router.close()` (which closes the edit store), logs `daemon.stopped` only if it was running.
- `IDEBPDaemonServer.sweepSessions()` (`daemon-server.ts:140`): Invokes the transport heartbeat sweep directly for deterministic tests and health tooling.
- Constructor callback wiring (`daemon-server.ts:46-102`):
  - `onSessionOpened` → `registry.open(connection)` + `logger.sessionOpened(sessionId, role)`.
  - `onSessionActivity` → `registry.touch(sessionId)`.
  - `onSessionClosed` → `router.sessionClosed(connection, reason)` + `logger.sessionClosed(sessionId, role, reason)`.
  - `onHandshakeRejected` → `logger.handshakeRejected(reason)`.
  - `onAuthenticatedMessage` → `logger.beginOperation()` + `rpcLogMetadata` extraction → `router.handle()` → `logger.rpcMessageProcessed(metadata, startedAt, "processed"|"error")`. ADR-0035 instrumentation: `performance.now()` timing at `:89` and `this.router.metrics.recordCall(metadata.method, durationMs)` in the finally block at `:98`. Counted whether succeeded or refused — a refusal is a served request. Only counted when `metadata.method !== undefined` (malformed requests not counted).
- `rpcLogMetadata(sessionId, value)` (`daemon-server.ts:158`): Safely extracts `requestId` and `method` from an unknown message value. Validates `id` via `isJSONRPCRequestIdentifier` and `method` via `typeof === "string"`. Returns `{ sessionId }` minimum if extraction fails.

## Data & Control Flow

1. WebSocket connection arrives → `LoopbackWebSocketServer` validates loopback address → handshake via `HandshakeProcessor`.
2. On successful handshake → `onSessionOpened` callback → `SessionRegistry.open()` registers the session + `logger.sessionOpened`.
3. Subsequent messages → `rpcLogMetadata` extracts correlation metadata → `ApplicationRouter.handle()` → `logger.rpcMessageProcessed` records duration and result (`"processed"` or `"error"`).
4. Router classifies message: request (adapter-local, consumer-local, routed, plan-store) vs notification vs response.
5. Routed requests: consumer ID remapped to route ID → forwarded to adapter. Adapter response remapped back.
6. Plan-store requests (`refactor/prepare`, `refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, `workspace/undo`): intercepted by `#routeEditRequest`, public/private identity translation via `InMemoryEditStore`, result validation and undo-token creation.
7. Pong/application activity → `registry.touch()`; missed heartbeat windows close only that socket.
8. On connection close → `router.sessionClosed()` cleans routes/plans/session state and broadcasts the canonical adapter reason → `logger.sessionClosed`.
9. On `close()`: transport closes all sockets → dashboard closes (`:150-151`) → `router.close()` closes the edit store → `logger.daemonStopped`.
10. Dashboard (optional, ADR-0035): `startDashboard()` constructs `DashboardServer` with snapshot from `router.status()` + `registry.listAdapters()` + `registry.listWorkspaces()`. Returns URL with single-use launch token. Browser exchanges launch token for session token, then polls `/data` with Bearer auth. Read-only, loopback, GET only.

## Integration Points

- **Consumed by**: `@ide-bridge/bridge-client` (consumer), `vscode-extension` (adapter), `integrations/serena` (consumer), `@ide-bridge/conformance` (tests).
- **Depends on**: `@ide-bridge/protocol` (types, validators, constants), `ws` (WebSocket server), `node:http` (dashboard server), `node:crypto`, `node:fs/promises`, `node:net`, `node:path`, `node:perf_hooks`. Dashboard server also depends on `../security/authentication-token.js` for token generation and constant-time comparison.
- **External boundaries**: Listens on `127.0.0.1:0` (ephemeral port) at path `/rpc`. Dashboard (when started) listens on a separate `127.0.0.1:0` HTTP port. Discovery file written to filesystem with `0600` permissions. Token passed via constructor option, not env var (caller's responsibility).

## Common Gotchas

- All `.js` import specifiers in `index.ts` are intentional — NodeNext ESM requires `.js` extensions even for `.ts` source files.
- `IDEBPDaemonServer.registry` and `.router` are public readonly; the transport, logger, and dashboard are private (`#transport`, `#logger`, `#dashboard`). External code can inspect state via registry/router but cannot send messages directly.
- The `InMemoryEditStore` runs a background `setInterval` sweep timer that is `.unref()`-ed, so it won't keep the process alive. Call `close()` to stop it.
- `close()` calls `router.close()` (`daemon-server.ts:152`) which in turn calls `editStore.close()` — the edit store timer is stopped as part of daemon shutdown. `close()` also closes the dashboard (`:150-151`) if one was started.
- `PLAN_STORE_METHODS` are intercepted by the router and rebound through `InMemoryEditStore`; public consumer IDs are never forwarded as adapter plan or undo identities.
- `DAEMON_VERSION` is hardcoded as `"0.0.0"` — not derived from package.json at runtime.
- The daemon library defaults to a silent logger (`daemon-server.ts:43`). The CLI/process owner must explicitly supply a sink and level; this prevents library tests and embedders from receiving unsolicited stderr output.
- `rpcLogMetadata` never throws — it returns `{ sessionId }` as a minimum even for malformed messages (`daemon-server.ts:166`).
