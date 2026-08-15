# packages/bridge-daemon/src/session/

## Responsibility

Session lifecycle management: handshake authentication/protocol negotiation and in-memory registry of sessions, adapters, and workspaces. The `HandshakeProcessor` validates tokens, negotiates protocol versions, and creates `AuthenticatedSession` objects. The `SessionRegistry` is the daemon's central state store, tracking connections, adapters, workspaces, and enforcing ownership invariants with defensive copying on all returns. 334 lines (`session-registry.ts`).

## Design Patterns

- **Command / Processor**: `HandshakeProcessor` (`handshake-processor.ts:137`) encapsulates the entire handshake validation pipeline. `process(value: unknown): HandshakeOutcome` is the single entry point, returning a discriminated union (`accepted: true/false`).
- **Registry / In-Memory Store**: `SessionRegistry` (`session-registry.ts:50`) maintains four parallel `Map` structures: sessions, adapters, adapter-by-session, workspaces. All public getters return `structuredClone` results.
- **Discriminated Union**: `HandshakeOutcome` (`handshake-processor.ts:55`) — `{ accepted: true; response; session }` or `{ accepted: false; response }`.
- **Factory Pattern**: `createSessionId` is injectable (`handshake-processor.ts:155`), default uses `randomBytes(18).toString("base64url")` prefixed with `session_`.
- **Timing-Safe Comparison**: Token comparison via `authenticationTokensEqual` from `../security/authentication-token.js` (`handshake-processor.ts:171`) — SHA-256 hash + `timingSafeEqual`.
- **Semantic Version Comparison**: `compareProtocolVersions` (`handshake-processor.ts:70`) parses semver with `BigInt` to avoid floating-point issues.
- **Trust-Only Update**: `updateWorkspaceTrust` (`session-registry.ts:288-301`) updates ONLY the `trust` field via `{ ...record.workspace, trust }` rather than replacing the whole record — trust changing invalidates nothing else about the workspace (ADR-0022).
- **Epoch-Advancing Root Replacement**: `updateWorkspaceRoots` (`session-registry.ts:256-274`) replaces roots AND advances `workspaceEpoch`, requiring the new epoch to be strictly greater than the current one.

## Key Types

- `AuthenticatedSession` (`handshake-processor.ts:37`): `sessionId`, `role`, `protocolVersion`, `clientName`, `clientVersion`, `clientTopology`, `connectedAt`, `lastActivityAt`.
- `HandshakeProcessorOptions` (`handshake-processor.ts:48`): `expectedToken`, `supportedProtocolVersions`, `createSessionId`, `now`.
- `HandshakeOutcome` (`handshake-processor.ts:55`): Accepted/rejected discriminated union.
- `SessionRegistry` (`session-registry.ts:50`): In-memory store. Public readonly: `sessionCount`, `adapterCount`, `workspaceCount`.
- `SessionRecord` (`session-registry.ts:29-31`): Internal — `{ connection: AuthenticatedTransportConnection, snapshot: Session }`.
- `AdapterRecord` (`session-registry.ts:34-36`): Internal — `{ adapter: Adapter, sessionId: SessionId }`.
- `WorkspaceRecord` (`session-registry.ts:39-41`): Internal — `{ workspace: Workspace, status: WorkspaceStatus }`.
- `RemovedSession` (`session-registry.ts:44-47`): Return type of `close()` — `{ session, adapter?, workspaces[] }`.
- `SessionRegistryError` (`session-registry.ts:19-26`): Error with `code: RegistryErrorCode` (`ADAPTER_NOT_FOUND`, `WORKSPACE_NOT_FOUND`, `PERMISSION_DENIED`, `PRECONDITION_FAILED`).
- `RegistryErrorCode` (`session-registry.ts:16-17`): `"ADAPTER_NOT_FOUND" | "WORKSPACE_NOT_FOUND" | "PERMISSION_DENIED" | "PRECONDITION_FAILED"`.
- `DEFAULT_DAEMON_TOPOLOGY` (`handshake-processor.ts:31`): `{ hostKind: "local", environmentKind: "local", uriSchemes: ["file"] }`.

## Key Functions

- `HandshakeProcessor.process(value)` (`handshake-processor.ts:160`): Validates handshake request → token comparison → protocol version negotiation (findLast matching supported version) → creates `AuthenticatedSession` and `BridgeHandshakeResponse`.
- `compareProtocolVersions(left, right)` (`handshake-processor.ts:70`): Parses semver strings via regex, compares with `BigInt`, returns `-1/0/1`.
- `createInvalidHandshakeRequestResponse(value)` (`handshake-processor.ts:101`): Factory for `-32600` "Invalid Request" error responses. Recovers `id` from the raw value.
- `SessionRegistry.open(connection)` (`session-registry.ts:73`): Registers a session from an authenticated connection. Throws `PRECONDITION_FAILED` if `sessionId` already exists.
- `SessionRegistry.close(sessionId)` (`session-registry.ts:97`): Removes session, its adapter, and all workspaces. Returns `RemovedSession | undefined`.
- `SessionRegistry.registerAdapter(sessionId, params)` (`session-registry.ts:111`): Creates `Adapter` + workspaces. Requires `role === "adapter"`. Validates workspace ID uniqueness and adapter ID match.
- `SessionRegistry.getWorkspaceConnection(workspaceId)` (`session-registry.ts:206`): Resolves the `AuthenticatedTransportConnection` for a workspace's adapter. Used by the router to forward routed requests.
- `SessionRegistry.assertAdapterOwnership(sessionId, adapterId)` (`session-registry.ts:222`): Throws `PERMISSION_DENIED` if the adapter doesn't belong to the session.
- `SessionRegistry.assertWorkspaceOwnership(sessionId, workspaceId): Workspace` (`session-registry.ts:228-231`): Resolves workspace via `getWorkspace`, then checks adapter ownership. Returns the workspace snapshot (cloned) after asserting the session owns the adapter that owns the workspace.
- `SessionRegistry.updateWorkspaceRoots(sessionId, workspaceId, adapterId, roots, workspaceEpoch)` (`session-registry.ts:256-274`): Asserts adapter ownership, validates workspace exists and belongs to the adapter. Rejects if `workspaceEpoch <= record.workspace.workspaceEpoch` (must be monotonically increasing). Replaces roots and advances epoch.
- `SessionRegistry.updateWorkspaceTrust(sessionId, workspaceId, adapterId, trust)` (`session-registry.ts:288-301`): Asserts adapter ownership, validates workspace exists and belongs to the adapter. Updates ONLY the `trust` field via `{ ...record.workspace, trust }` — does NOT touch roots, epoch, documents, or handles (ADR-0022).
- `SessionRegistry.updateWorkspaceStatus(sessionId, status)` (`session-registry.ts:276-281`): Asserts workspace ownership, replaces status record.
- `SessionRegistry.updateCapabilities(sessionId, adapterId, capabilities)` (`session-registry.ts:234-239`): Asserts adapter ownership, replaces capabilities.
- `SessionRegistry.consumerConnections()` (`session-registry.ts:216`): Returns live connection objects for all consumer sessions (not cloned).

## Data & Control Flow

**Handshake**:

1. Raw JSON message arrives → `HandshakeProcessor.process(value)`.
2. `recoverResponseId(value)` extracts the JSON-RPC `id` (or `null`).
3. `classifyBridgeHandshakeRequest(value)` from `@ide-bridge/protocol` validates structure.
4. If `validation.kind === "authentication"` → return `AuthenticationFailed` (-32001).
5. If `validation.kind === "invalid"` → return `InvalidRequest` (-32600).
6. Token comparison: `authenticationTokensEqual(expectedToken, request.params.authentication.token)`.
7. Protocol negotiation: check `minimum <= maximum`, find last supported version in `[minimum, maximum]` range.
8. Create `AuthenticatedSession` (with `structuredClone` of topology) and `BridgeHandshakeResponse` (with `structuredClone` of `DEFAULT_DAEMON_TOPOLOGY`).

**Registry lifecycle**:

1. `open(connection)` → session stored with snapshot.
2. `touch(sessionId)` → updates `lastActivityAt` after authenticated application traffic or a WebSocket pong.
3. `registerAdapter(sessionId, params)` → adapter + workspaces stored.
4. Various `list*` / `get*` calls → all return `structuredClone` copies.
5. `close(sessionId)` → removes session, adapter, all workspaces in one operation.

**Workspace updates**:

1. `updateWorkspaceRoots` → replaces roots array, advances `workspaceEpoch` (must be strictly greater) (`:256-274`).
2. `updateWorkspaceTrust` → updates only `trust` field, preserves everything else (`:288-301`).
3. `updateWorkspaceStatus` → replaces status record (`:276-281`).

## Integration Points

- **Consumed by**: `LoopbackWebSocketServer` (handshake), `IDEBPDaemonServer` (registry), `ApplicationRouter` (registry — calls `updateWorkspaceTrust`, `updateWorkspaceRoots`, `assertWorkspaceOwnership`, `getWorkspace`, etc.).
- **Depends on**: `@ide-bridge/protocol` (types, validators, `PROTOCOL_VERSION`), `../security/authentication-token.js` (token validation/comparison), `../metadata.js` (`DAEMON_NAME`, `DAEMON_VERSION`), `../transport/transport.js` (`AuthenticatedTransportConnection` type only), `node:crypto` (`randomBytes`).
- **External boundaries**: No direct I/O. All functions are synchronous except the constructor. Session IDs follow pattern `session_[A-Za-z0-9_-]+`.

## Common Gotchas

- All public registry getters return `structuredClone` results (`session-registry.ts:105-108,157-159,164-171,174-178,180-184,186-204,206,317-320`) — callers cannot mutate internal state. This is a performance trade-off for safety.
- **`updateWorkspaceTrust` updates ONLY the `trust` field** (`session-registry.ts:288-301`) — it uses `{ ...record.workspace, trust }` to preserve roots, epoch, and all other fields. Trust changing invalidates nothing else (ADR-0022). Do not replace the whole workspace record.
- **`updateWorkspaceRoots` requires strictly increasing `workspaceEpoch`** (`session-registry.ts:269-271`) — `workspaceEpoch <= record.workspace.workspaceEpoch` throws `PRECONDITION_FAILED`. This is the monotonic epoch invariant.
- **`assertWorkspaceOwnership` returns the workspace** (`session-registry.ts:228-231`) — it resolves the workspace (cloned), asserts adapter ownership, and returns the workspace. Callers can use the returned value without a second `getWorkspace` call.
- `HandshakeProcessor` constructor sorts supported versions with `compareProtocolVersions` and deduplicates (`handshake-processor.ts:147`). The `findLast` selection picks the highest compatible version.
- `SessionRegistry.getWorkspaceConnection` (`session-registry.ts:206`) returns the live `AuthenticatedTransportConnection` object (NOT cloned) — this is intentional so the router can call `.send()` on it.
- `SessionRegistry.consumerConnections()` (`session-registry.ts:216`) also returns live connection objects (not cloned) for broadcasting.
- `SessionRegistry.close()` (`session-registry.ts:97`) returns `undefined` (not an error) if the session doesn't exist — callers must handle this.
- Heartbeat counters belong to the transport, while `lastActivityAt` belongs to this registry. The composed daemon connects the transport activity callback to `touch()`; the registry does not run timers.
- The `SESSION_ID_PATTERN` (`handshake-processor.ts:29`) validates the factory output — a custom `createSessionId` that returns a non-matching ID throws.
- Protocol version comparison uses `BigInt` (`handshake-processor.ts:67`) to avoid floating-point precision issues with large version numbers.
- `structuredClone` is used on `clientTopology` and `DEFAULT_DAEMON_TOPOLOGY` in the handshake response (`handshake-processor.ts:206,218`) — the response carries independent copies, not shared references.
