# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/protocol/

## Responsibility
Kotlin mirror of the IDE Bridge Protocol (IDEBP) wire contract. Defines every serializable data class, enum, and method/notification catalogue required for the JetBrains adapter to communicate with the daemon. This is the second expression of the canonical JSON Schema contracts in `packages/protocol/schemas/` (AGENTS.md §2) — the schemas remain authoritative, and `WireConformanceTest` round-trips every canonical fixture through these declarations to catch divergence. The package has zero imports from IntelliJ Platform, VS Code, or Serena code, preserving protocol independence.

## Design Patterns
- **Schema-Mirrored Serialization**: Every `@Serializable` data class and enum `@SerialName` directly mirrors the JSON Schema 2020-12 definitions in `packages/protocol/schemas/`. The Kotlin types are generated-by-hand from schemas, not the reverse. `Json.kt` config enforces the contract: `ignoreUnknownKeys=false` mirrors `additionalProperties:false`, `explicitNulls=false` distinguishes absent from null, `encodeDefaults=true` emits required constants (Json.kt:24-31).
- **Type Aliases for Identifiers**: All protocol identifiers (`AdapterId`, `SessionId`, `WorkspaceId`, etc.) are `typealias` to `String` (CommonTypes.kt:14-21) so signatures read as the protocol does without wrapper types that kotlinx.serialization would have to unwrap.
- **`JsonPrimitive` for JSON-RPC IDs**: `JsonRpcId = JsonPrimitive` (CommonTypes.kt:29) so a numeric identifier travels back exactly as it arrived — coercing to string would change the value the peer correlates on.
- **`init` Block Validation**: Request/Response/Notification envelopes and parameter classes validate `jsonrpc == "2.0"`, `method` membership, and type tags in `init` blocks (Methods.kt:22-25, 30-32; Handshake.kt:51-54; Notifications.kt:19-22; EditTypes.kt:22, 33). This catches contract violations at construction, before serialization.
- **Method Catalogue Partitioning**: Methods are partitioned into `ADAPTER_ORIGINATED_METHODS`, `CONSUMER_LOCAL_METHODS`, and `ROUTED_METHODS` (Methods.kt:250-282), mirroring `packages/protocol/src/application-validation.ts`. `Request.init` validates membership in `APPLICATION_METHODS` (line 24). `CatalogueCoverageTest` reads canonical schemas to prove nothing is missing.
- **Notification Direction Typing**: `ADAPTER_OUTBOUND_NOTIFICATION_METHODS` (Notifications.kt:83-97) lists what this plugin announces; `adapter/disconnected` is daemon-to-adapter; `$/cancelRequest` is consumer-to-daemon. Sending in the wrong direction closes the session. `Notification.init` validates membership in `NOTIFICATION_METHODS` (line 21).
- **Nullability as Optionality**: Optional fields are nullable with `null` defaults; required fields are non-null with no default. `explicitNulls=false` in `IdebpJson` means nullable-with-null fields are absent on the wire, never serialized as `null`. This distinguishes "absent" from "null" as the schemas require (Json.kt:13-18).
- **Sealed-Shape Discrimination via Parse Order**: The handshake error response (`HandshakeErrorResponse`) and the application error response (`ErrorResponse`) are distinct contracts. Callers attempt to decode the error shape before the success shape (see `connection/` codemap).

## Key Types

### JSON Configuration
- `IdebpJson: Json` (Json.kt:24) — Singleton. `ignoreUnknownKeys=false`, `explicitNulls=false`, `encodeDefaults=true`, `isLenient=false`. Every message is encoded/decoded through this instance.

### Common Types (CommonTypes.kt)
- Type aliases (lines 14-21): `AdapterId`, `SessionId`, `WorkspaceId`, `RootId`, `SymbolHandleId`, `PlanId`, `UndoTokenId`, `ContentHash` → `String`. `JsonRpcId` → `JsonPrimitive` (line 29).
- `PositionEncoding` (line 33): enum `UTF16`/`UTF8`/`UTF32` with `@SerialName("utf-16")` etc.
- `Position(line: Int, character: Int)` (line 45), `Range(start: Position, end: Position)` (line 48), `Location(uri: String, range: Range, positionEncoding: PositionEncoding)` (line 51).
- `Revision(editorVersion: Int? = null, contentHash: ContentHash, workspaceEpoch: Int)` (line 62) — `editorVersion` absent for content not open in an editor buffer (ADR-0020). `contentHash` is authoritative identity.
- `DocumentReference(workspaceId, rootId, uri, logicalPath?, revision, positionEncoding, languageId?, isDirty)` (line 69) — Full document identity including revision precondition.
- `DocumentContent(document: DocumentReference, text: String)` (line 81).
- `WorkspaceTrust` (line 84): enum `TRUSTED`/`UNTRUSTED`/`UNKNOWN`.
- `WorkspaceRoot(rootId: RootId, name: String, uri: String)` (line 96).
- `Workspace(workspaceId, adapterId, name, roots: List<WorkspaceRoot>, workspaceEpoch: Int, trust: WorkspaceTrust)` (line 99).
- `ReadinessState` (line 109): enum `INITIALIZING`/`INDEXING`/`READY`/`DEGRADED`/`DISCONNECTED`.
- `WorkspaceStatus(workspaceId, state: ReadinessState, capabilitiesUnavailable: List<String>, progress: ReadinessProgress)` (line 130).
- `Support` (line 138): enum `NATIVE`/`PROVIDER`/`ADAPTER`/`UNAVAILABLE`.
- `Guarantee` (line 153): enum `SEMANTIC`/`SYNTACTIC`/`ANCHORED_TEXT`/`RAW_TEXT`.
- `Atomicity` (line 168): enum `NONE`/`TEXT_ONLY`/`SEMANTIC`.
- `Capability(support: Support, guarantee?, preview?, atomicity?, reason?)` (line 185) — Capability dimensions are operation-dependent (ADR-0005). Every dimension but `support` is nullable; an omitted dimension is not applicable and must never be inferred.
- `HostKind` (line 194): enum `LOCAL`/`REMOTE_WORKSPACE`/`WEB`/`GATEWAY`.
- `EnvironmentKind` (line 209): enum `LOCAL`/`WSL`/`DEV_CONTAINER`/`CODESPACE`/`SSH`/`JETBRAINS_REMOTE`/`UNKNOWN`.
- `UriMappingDirection` (line 233): enum `CLIENT_TO_DAEMON`/`DAEMON_TO_CLIENT`/`BIDIRECTIONAL`.
- `UriMapping(sourceUriPrefix, targetUriPrefix, direction)` (line 245).
- `EndpointTopology(hostKind: HostKind, environmentKind: EnvironmentKind, uriSchemes: List<String>, uriMappings: List<UriMapping>? = null)` (line 252).

### Handshake (Handshake.kt)
- `SessionRole` (line 14): enum `ADAPTER`/`CONSUMER`.
- `HandshakeAuthentication(method: String = "token", token: String)` (line 23) — `init` requires `method == "token"`.
- `ProtocolRange(minimum: String, maximum: String)` (line 30).
- `PeerInfo(name: String, version: String)` (line 33).
- `HandshakeParams(authentication, role, protocol, topology, clientInfo)` (line 36).
- `HandshakeRequest(jsonrpc = "2.0", id: JsonRpcId, method = "bridge/handshake", params)` (line 45) — `init` validates `jsonrpc` and `method`.
- `HandshakeResult(sessionId, role, protocolVersion, daemonInfo: PeerInfo, topology)` (line 58).
- `HandshakeErrorData(code: ErrorCode, retryable: Boolean, supportedProtocol: ProtocolRange? = null)` (line 74) — Distinct from application `ErrorData`. Carries the daemon's supported range on version mismatch.
- `HandshakeError(code: Int, message: String, data: HandshakeErrorData)` (line 81).
- `HandshakeErrorResponse(jsonrpc = "2.0", id: JsonRpcId, error: HandshakeError)` (line 88) — `id` is typed non-nullable so `JsonNull` is carried as a literal (the one place the contract distinguishes explicit null from absent key).

### Errors (Errors.kt)
- `ErrorCode` (line 16): enum with 21 values — `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL_VERSION`, `AUTHENTICATION_FAILED`, `WORKSPACE_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `ADAPTER_NOT_FOUND`, `ADAPTER_DISCONNECTED`, `CAPABILITY_UNAVAILABLE`, `INDEX_NOT_READY`, `STALE_DOCUMENT`, `STALE_SYMBOL`, `AMBIGUOUS_SYMBOL`, `INVALID_IDENTIFIER`, `PRECONDITION_FAILED`, `PLAN_NOT_FOUND`, `PLAN_EXPIRED`, `PROVIDER_FAILED`, `TIMEOUT`, `CANCELLED`, `PERMISSION_DENIED`, `PARTIAL_APPLY`, `INTERNAL_ERROR`.
- `ErrorDetails` (line 85): all fields nullable — `adapterId`, `workspaceId`, `documentUri`, `planId`, `capability`, `currentRevision: Revision?`, `candidates: List<SymbolLocator>?`, `modifiedDocuments: List<ModifiedDocument>?`. Structural invariants (e.g. `INDEX_NOT_READY` must be retryable, `STALE_DOCUMENT` must carry `currentRevision`) are enforced by the daemon and fixtures, not by this type.
- `ErrorData(code: ErrorCode, retryable: Boolean, details: ErrorDetails? = null)` (line 97).
- `JsonRpcError(code: Int, message: String, data: ErrorData)` (line 104).
- `ErrorResponse(jsonrpc = "2.0", id: JsonRpcId, error: JsonRpcError)` (line 107).

### Discovery (Discovery.kt)
- `DiscoveryFile(protocolVersion, endpoint, token, pid, startedAt)` (line 13) — All `String`/`Int` fields, no optionals. Carries the auth token; `0600` on Unix, contents never logged.

### Methods (Methods.kt)
- `Request<P>(jsonrpc = "2.0", id: JsonRpcId, method: String, params: P)` (line 16) — Generic envelope. `init` validates `jsonrpc` and `method in APPLICATION_METHODS`.
- `Response<R>(jsonrpc = "2.0", id: JsonRpcId, result: R)` (line 29).
- `IdeKind` (line 38): enum `VSCODE`/`JETBRAINS`.
- `Adapter` (line 47), `Session` (line 60) — Daemon-side state mirrors.
- Lifecycle params/results (lines 70-107): `IdeRegisterParams`/`Result`, `IdeUnregisterParams`/`Result`, `IdePingParams`/`Result`, `IdeGetCapabilitiesParams`/`Result`.
- Workspace params/results (lines 112-124): `WorkspaceListParams`/`Result`, `WorkspaceIdParams`, `WorkspaceGetResult`, `WorkspaceGetStatusResult`.
- Document params/results (lines 129-138): `DocumentTargetParams`, `DocumentGetRevisionResult`, `DocumentGetSymbolsResult`.
- Symbol params/results (lines 143-176): `WorkspaceSearchSymbolsParams`/`Result`, `SymbolResolveAtParams`/`Result` (`symbol` nullable — ADR-0018), `SymbolTargetParams`, `SymbolLocationsResult` (shared by getDefinition/getReferences/getImplementations — ADR-0024).
- Diagnostics params/results (lines 181-191): `DiagnosticsGetSnapshotParams`/`Result`.
- Refactoring params/results (lines 196-223): `RenameOptions`, `RefactorPrepareRenameParams`/`Result`, `WorkspaceApplyPlanParams`, `WorkspaceDiscardPlanParams`/`Result`, `WorkspaceUndoParams`.
- Bridge administration (lines 228-245): `EmptyParams`, `BridgeGetStatusResult`, `BridgeListAdaptersResult`, `BridgeListSessionsResult`.
- Method catalogues (lines 250-285):
  - `ADAPTER_ORIGINATED_METHODS`: `ide/register`, `ide/unregister`, `ide/ping` (3 methods).
  - `CONSUMER_LOCAL_METHODS`: `ide/getCapabilities`, `workspace/list`, `workspace/get`, `workspace/getStatus`, `bridge/getStatus`, `bridge/listAdapters`, `bridge/listSessions` (7 methods).
  - `ROUTED_METHODS`: `document/read`, `document/getRevision`, `document/getSymbols`, `workspace/searchSymbols`, `symbol/resolveAt`, `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations`, `diagnostics/getSnapshot`, `refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, `workspace/undo` (13 methods).
  - `APPLICATION_METHODS` = union of all three (23 methods).

### Notifications (Notifications.kt)
- `Notification<P>(jsonrpc = "2.0", method: String, params: P)` (line 14) — Generic envelope. `init` validates `method in NOTIFICATION_METHODS`.
- 13 outbound adapter notification param types (lines 26-78): `CapabilitiesChangedParams`, `WorkspaceOpenedParams`, `WorkspaceClosedParams`, `WorkspaceRootsChangedParams`, `WorkspaceReadinessChangedParams`, `WorkspaceTrustChangedParams`, `DocumentEventParams`, `DocumentDeletedParams` (no revision — ADR-0022), `DocumentRenamedParams`, `DiagnosticsChangedParams`.
- 2 inbound: `AdapterDisconnectedParams` (daemon→adapter), `CancelRequestParams` (consumer→daemon).
- `ADAPTER_OUTBOUND_NOTIFICATION_METHODS` (line 83): 13 methods.
- `NOTIFICATION_METHODS` (line 99): 15 methods (13 outbound + `adapter/disconnected` + `$/cancelRequest`). The `$` is escaped as `\$` in Kotlin string literals.

### Symbol Types (SymbolTypes.kt)
- `SymbolKind` (line 15): enum with 25 values (`FILE` through `TYPE_PARAMETER`), each with `@SerialName`.
- `SymbolHandle(adapterId, sessionId, id: SymbolHandleId, validUntilEpoch: Int)` (line 96) — Fast path, session-bound.
- `SymbolLocator(documentUri, name, qualifiedName?, kind: SymbolKind, containerName?, selectionRange: Range, positionEncoding, fingerprint: ContentHash)` (line 104) — Durable identity. `fingerprint` is SHA-256 (ADR-0003, ADR-0018).
- `SymbolReference(handle: SymbolHandle? = null, locator: SymbolLocator? = null)` (line 117) — At least one must be present (schema `anyOf`). Both nullable to model the union.
- `Symbol(handle: SymbolHandle, locator: SymbolLocator, range: Range, children: List<Symbol>)` (line 123) — Recursive (`children: List<Symbol>`).
- `SymbolLocation(location: Location, symbol: Symbol? = null)` (line 131).

### Diagnostic Types (DiagnosticTypes.kt)
- `DiagnosticSeverity` (line 8): enum `ERROR`/`WARNING`/`INFORMATION`/`HINT`.
- `RelatedInformation(location: Location, message: String)` (line 23).
- `Diagnostic(range, positionEncoding, severity, message, source?, code: JsonPrimitive?, relatedInformation: List<RelatedInformation>?)` (line 30) — `code` is `JsonPrimitive` (not collapsed to string) because `string | integer` on the wire; rewriting an integer code as text would change what the language service reported.
- `DocumentDiagnostics(document: DocumentReference, diagnostics: List<Diagnostic>)` (line 41).

### Edit Types (EditTypes.kt)
- `DocumentRevisionPrecondition(type = "documentRevision", uri, editorVersion: Int? = null, contentHash, workspaceEpoch: Int)` (line 14) — `init` validates type tag. `editorVersion` absent for content not open in an editor (ADR-0020).
- `ChangeSummary(kind = "textEdit", uri, editCount: Int)` (line 27) — `init` validates kind.
- `EditOperation` (line 38): enum `RENAME` only (Phase 4 scope).
- `EditPlan(planId, adapterId, sessionId, workspaceId, expiresAt, operation: EditOperation, guarantee: Guarantee, atomicity: Atomicity, preconditions: List<DocumentRevisionPrecondition>, changes: List<ChangeSummary>, warnings: List<String>)` (line 44).
- `ModifiedDocument(document: DocumentReference, beforeHash: ContentHash, afterHash: ContentHash)` (line 59).
- `UndoToken(id: UndoTokenId, adapterId, sessionId, workspaceId, expiresAt: String? = null)` (line 66).
- `ModificationResult(modifiedDocuments: List<ModifiedDocument>, undoToken: UndoToken? = null, diagnostics: List<DocumentDiagnostics>? = null)` (line 75).

## Key Functions
This package is purely declarative — data classes, enums, type aliases, and top-level catalogue lists. No functions beyond `init`-block validators (which throw `IllegalArgumentException` on contract violation) and the kotlinx.serialization-generated serializers.

## Data & Control Flow
This package has no control flow. It is consumed by:
1. `connection/` — `IdebpJson.encodeToString`/`decodeFromString` with these serializers for all handshake and RPC messages.
2. `service/` — Method params/results for adapter-initiated calls and notification payloads.
3. `WireConformanceTest` — Round-trips canonical fixtures through `IdebpJson` to verify the Kotlin mirror matches the JSON Schema.

Data enters as raw JSON strings from `WebSocketTransport.receive()`, is decoded via `IdebpJson.decodeFromString` with the appropriate serializer, and exits as typed Kotlin objects. Outbound: typed Kotlin objects are encoded via `IdebpJson.encodeToString` and sent through `WebSocketTransport.send()`.

## Integration Points
- **Consumed by**: `com.idebridge.jetbrains.connection` (handshake/RPC/transport), `com.idebridge.jetbrains.service` (adapter method handlers, notification dispatch), `test/` (`WireConformanceTest`, `CatalogueCoverageTest`).
- **Depends on**: `kotlinx.serialization` (`@Serializable`, `@SerialName`, `Json`, `JsonPrimitive`) — no IntelliJ Platform, VS Code, or Serena imports. This preserves protocol independence (AGENTS.md §2).
- **External boundaries**: None at runtime. The package is pure data declarations. The canonical contract source is `packages/protocol/schemas/` (JSON Schema 2020-12). The TypeScript types in `packages/protocol/src/` are the generated counterpart.

## Common Gotchas
- **`ignoreUnknownKeys=false` is a contract enforcement, not a style choice** — An unknown field is contract drift. The conformance suite relies on this failing loudly (Json.kt:10-11). Never change to `true`.
- **`explicitNulls=false` distinguishes absent from null** — Optional fields must be nullable with `null` defaults. Encoding nulls would produce messages the daemon rejects (Json.kt:13-18). Never set `explicitNulls=true`.
- **`encodeDefaults=true` is required for required constants** — `jsonrpc`, `method`, `type`, `kind` are expressed as Kotlin defaults and must appear on the wire. Suppressing defaults dropped them (Json.kt:15-18). Optionality is carried by nullability alone, never by a non-null default.
- **`HandshakeErrorResponse.id` is non-nullable despite being JSON null** — Typed non-nullable so `JsonNull` is carried as a literal, not omitted. This is the one place the contract distinguishes an explicit JSON null from an absent key (Handshake.kt:90-93).
- **`HandshakeErrorData` is distinct from `ErrorData`** — The handshake error carries `supportedProtocol`, the application error carries `details`. They have different shapes and must not be conflated.
- **`ErrorCode` has 21 values, not 20** — `PARTIAL_APPLY` is easy to miss (Errors.kt:77). The enum must stay in sync with the schema.
- **`SymbolReference` is an `anyOf`, not a oneOf** — At least one of `handle`/`locator` must be present. Both are nullable to model this in Kotlin; the "at least one" constraint is enforced by the schema and daemon, not by the type system (SymbolTypes.kt:115-120).
- **`DocumentDeletedParams` carries no revision** — A deleted document has an identity but no content (ADR-0022). Do not add a `revision` field.
- **`$/cancelRequest` must be escaped as `\$` in Kotlin** — The `$` is a string template character. In the method list it appears as `"\$/cancelRequest"` (Notifications.kt:100). In `@SerialName` it would appear unescaped, but there is no enum for notifications.
- **`Symbol.children` is recursive** — `Symbol` contains `List<Symbol>`. kotlinx.serialization handles this, but deep nesting will hit the default recursion guard. The daemon is expected to bound depth.
- **`Diagnostic.code` is `JsonPrimitive`, not `String`** — It is `string | integer` on the wire. Collapsing to string would rewrite an integer code as text and change what the language service reported (DiagnosticTypes.kt:26-28).
- **`EditOperation` has only `RENAME`** — This is Phase 4 scope, not a permanent limitation. Adding operations requires a schema change, an ADR, and updating `CatalogueCoverageTest`.
- **`Request.init` rejects unknown methods** — `require(method in APPLICATION_METHODS)` (Methods.kt:24). Adding a method without updating the catalogue will throw at construction time.
