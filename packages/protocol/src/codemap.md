# packages/protocol/src/

## Responsibility

Defines the IDE Bridge Protocol (IDEBP) — the canonical wire contract between IDE adapters (VS Code, JetBrains) and the bridge daemon. JSON Schema 2020-12 files in `packages/protocol/schemas/` are the source of truth; TypeScript types in `generated.ts` are derived from those schemas by `scripts/generate-types.ts`. This package provides runtime validation functions for handshake, discovery, and application-layer messages, method classification constants for role-based routing, the generated type definitions consumed by the daemon, client, and both IDE extensions, shared protocol constants (symbol search limits, diagnostic ceilings), and the canonical workspace URI containment rule shared between adapters and the daemon. It has zero imports from `vscode`, `@types/vscode`, JetBrains SDK, or Serena code (`AGENTS.md` §1, §2).

## Design Patterns

- **Schema-as-source-of-truth**: JSON Schema 2020-12 is canonical; TypeScript types are generated, not hand-written (`index.ts:4-6`, `generated.ts:1-6`). Validation code imports schemas as JSON and compiles them with Ajv 2020-12.
- **Module-level Ajv isolation**: Three separate Ajv instances — one per validation module — to prevent cross-module schema/state contamination (`application-validation.ts:321`, `handshake-validation.ts:21`, `discovery-validation.ts:9`). All use `{ allErrors: true, strict: true }`.
- **Discriminated-union classification**: Validation results are tagged unions (`kind: "valid" | "invalid" | ...`) rather than throwing or returning booleans, enabling callers to distinguish failure modes without inspecting Ajv internals (`application-validation.ts:425-432`, `handshake-validation.ts:54-57`, `handshake-validation.ts:85-88`).
- **Method-keyed validator maps**: Request, response, and notification validators are indexed by method name, producing O(1) lookup at runtime (`application-validation.ts:358-375`).
- **Type-map dispatch**: `IDEBPApplicationRequestByMethod` / `IDEBPApplicationResponseByMethod` / `IDEBPNotificationByMethod` are mapped types that associate string method names with their concrete request/response/notification types, enabling generic type-safe dispatch (`application-validation.ts:103-179`).
- **Role-based method classification**: Method names are partitioned into `IDEBP_ADAPTER_ORIGINATED_METHODS`, `IDEBP_CONSUMER_LOCAL_METHODS`, and `IDEBP_ROUTED_METHODS` to enforce which session role may send or receive each request method (`application-validation.ts:251-285`).
- **Direction-based notification classification**: Notification methods are partitioned into `IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS` and `IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS` to enforce session-role direction (`application-validation.ts:289-308`).
- **Security-conscious validation**: `classifyBridgeHandshakeRequest` distinguishes authentication failures from structural failures without leaking token values or Ajv error details (`handshake-validation.ts:68-75`). `classifyBridgeHandshakeServerMessage` validates without exposing payload details in failures (`handshake-validation.ts:90-97`).
- **Shared containment rule**: `isUriWithinWorkspaceRoot` lives in `workspace-uri.ts` within the protocol package so adapters and the daemon apply one identical rule byte-for-byte (`workspace-uri.ts:1-6`). An adapter whose containment check is looser than the daemon's would emit results the daemon rejects as a policy violation, so both sides must share one definition (ADR-0017).

## Key Types

### Protocol identity & versioning (`generated.ts`, `index.ts`)

- `IDEBPProtocolVersion` (`generated.ts:34`) — string alias for semantic version.
- `PROTOCOL_VERSION` (`index.ts:53`) — `"0.1.0" as const`; the current protocol version.
- `ProtocolVersion` (`index.ts:55`) — `typeof PROTOCOL_VERSION`.
- `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT = 200` (`index.ts:64`) — shared `workspace/searchSymbols` default result bound. The adapter caps at the effective limit and the daemon rejects results exceeding it, so a divergent default would cost an adapter its session (ADR-0017).
- `IDEBP_MAX_SYMBOL_SEARCH_LIMIT = 1000` (`index.ts:67`) — absolute ceiling for `workspace/searchSymbols`, matching the schema `limit` maximum.
- `IDEBP_MAX_SYMBOL_LOCATIONS = 1000` (`index.ts:74`) — fixed ceiling for `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations`, and `symbol/getHierarchy`, which carry no `limit` parameter (ADR-0018).
- `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS = 500` (`index.ts:77`) / `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT = 1000` (`index.ts:80`) — snapshot ceilings shared by adapter and daemon (ADR-0019). Diagnostic `message` is deliberately unbounded; size is controlled by dropping whole documents, never by clipping text.
- `IDEBPSessionRole` (`generated.ts:49`) — `"adapter" | "consumer"`.
- `IDEBPHandshakeAuthentication` (`generated.ts:510-513`) — `{ method: "token", token: AuthenticationToken }`.
- `IDEBPEndpointTopology` (`generated.ts:520-533`) — describes hostKind, environmentKind, uriSchemes, and optional uriMappings. URI mappings are explicit, never inferred.

### Handshake (`generated.ts`)

- `BridgeHandshakeRequest` (`generated.ts:483-503`) — first WebSocket message; carries authentication, role, protocol version range, topology, clientInfo.
- `BridgeHandshakeResponse` (`generated.ts:540-553`) — creates session; returns sessionId, role, protocolVersion, daemonInfo, topology.
- `BridgeHandshakeErrorResponse` (`generated.ts:14-15`) — union of `InvalidRequest | AuthenticationFailed | UnsupportedProtocolVersion`.

### Discovery (`generated.ts`)

- `IDEBPDiscoveryFile` (`generated.ts:836-842`) — `{ protocolVersion, endpoint, token, pid, startedAt }`. Private local file for daemon discovery.

### Core domain objects (`generated.ts`)

- `Adapter` (`generated.ts:558-571`) — registered IDE adapter with capabilities, positionEncodings, ideKind.
- `Session` (`generated.ts:603-610`) — authenticated session with role, protocolVersion, timestamps.
- `Workspace` (`generated.ts:819-829`) — workspace with roots, workspaceEpoch, trust level.
- `WorkspaceRoot` (`generated.ts:810-814`) — `{ rootId, name, uri }`.
- `DocumentReference` (`generated.ts:664-673`) — document identity: workspaceId, rootId, uri, revision, positionEncoding, isDirty.
- `WorkspaceTrustChangedNotification` (`generated.ts`) — adapter-outbound trust update carrying workspaceId, adapterId, trust. `DocumentDeletedNotification` carries only workspaceId and uri: a deleted file has no content, so no revision (ADR-0022).
- `Revision` (`generated.ts`) — `{ editorVersion?, contentHash, workspaceEpoch }`. The precondition basis for two-phase edits. `editorVersion` is **optional**: it exists only while a document is open in an editor buffer, and a file on disk has none (ADR-0020). `contentHash` is the authoritative identity; editor versions are compared only when both sides carry one.
- `EditPlan` (`generated.ts:704-722`) — bound to adapter/session/workspace; carries preconditions, changes, guarantee, atomicity, expiresAt.
- `DocumentRevisionPrecondition` (`generated.ts`) — type `"documentRevision"` with uri, optional editorVersion, contentHash, workspaceEpoch.
- `ModificationResult` (`generated.ts:1169-1176`) — modifiedDocuments, optional undoToken, optional diagnostics.
- `UndoToken` (`generated.ts:747-753`) — undo handle for applied plans.
- `SymbolHandle` (`generated.ts:768-773`) — opaque handle with validUntilEpoch.
- `SymbolLocator` (`generated.ts:778-787`) — resolvable symbol identity with fingerprint.
- `Symbol` (`generated.ts:792-797`) — handle + locator + range + children (recursive).
- `SymbolReference` (`generated.ts:167-170`) — handle OR locator (discriminated by which field is present).

### Capability model (`generated.ts`)

- `Capabilities` (`generated.ts:576-578`) — `{ [k: string]: Capability }`.
- `Capability` (`generated.ts:69`) — `AvailableCapability | UnavailableCapability`.
- `AvailableCapability` (`generated.ts:585-590`) — `{ support, guarantee?, preview?, atomicity? }`.
- `Guarantee` (`generated.ts:74`) — `"semantic" | "syntactic" | "anchored-text" | "raw-text"`.
- `Atomicity` (`generated.ts:79`) — `"none" | "text-only" | "semantic"`.
- `Support` (`generated.ts:84`) — `"native" | "provider" | "adapter" | "unavailable"`.

### Error model (`generated.ts`)

- `IDEBPJSONRPCErrorResponse` (`generated.ts:847-855`) — JSON-RPC error with code, message, ErrorData.
- `ErrorCode` (`generated.ts:224-246`) — 21 variants including `INDEX_NOT_READY`, `STALE_DOCUMENT`, `STALE_SYMBOL`, `AMBIGUOUS_SYMBOL`, `PARTIAL_APPLY`, `PLAN_EXPIRED`, etc.
- `ErrorData` (`generated.ts:185-190`) — union of `GenericErrorData | IndexNotReadyErrorData | StaleDocumentErrorData | AmbiguousSymbolErrorData | PartialApplyErrorData`.
- `ErrorDetails` (`generated.ts:875-894`) — optional context fields (adapterId, workspaceId, documentUri, planId, candidates, modifiedDocuments, supportedProtocolVersion).

### Enums (`generated.ts`)

- `ReadinessState` (`generated.ts:119`) — `"initializing" | "indexing" | "ready" | "degraded" | "disconnected"`.
- `SymbolKind` (`generated.ts:136-162`) — 26 variants (file, module, namespace, ..., typeParameter).
- `PositionEncoding` (`generated.ts:64`) — `"utf-16" | "utf-8" | "utf-32"`.

### Method dispatch maps (`application-validation.ts`)

- `IDEBPApplicationRequestByMethod` (`application-validation.ts:103-131`) — 27 method names mapped to request types.
- `IDEBPApplicationResponseByMethod` (`application-validation.ts:133-161`) — 27 method names mapped to response types.
- `IDEBPNotificationByMethod` (`application-validation.ts:163-179`) — 15 notification method names mapped to notification types (including `$/cancelRequest` and `adapter/disconnected`).
- `IDEBPApplicationMethod` (`application-validation.ts:181`) — `keyof IDEBPApplicationRequestByMethod`.
- `IDEBPNotificationMethod` (`application-validation.ts:182`) — `keyof IDEBPNotificationByMethod`.
- `IDEBPRequestParams<M>` (`application-validation.ts:183-184`) — extracts `["params"]` from request type for method M.
- `IDEBPResponseResult<M>` (`application-validation.ts:185-186`) — extracts `["result"]` from response type for method M.
- `IDEBPNotificationParams<M>` (`application-validation.ts:187-189`) — extracts `NonNullable<["params"]>` from notification type.

### Method classification constants (`application-validation.ts`)

- `IDEBP_APPLICATION_METHODS` (`application-validation.ts:244-246`) — frozen array of all 27 application method names.
- `IDEBP_NOTIFICATION_METHODS` (`application-validation.ts:247-249`) — frozen array of all 15 notification method names.
- `IDEBP_ADAPTER_ORIGINATED_METHODS` (`application-validation.ts:251-255`) — 3 methods an adapter session may send: `ide/register`, `ide/unregister`, `ide/ping`.
- `IDEBP_CONSUMER_LOCAL_METHODS` (`application-validation.ts:257-265`) — 7 methods a consumer session may send that are handled locally by the daemon: `bridge/getStatus`, `bridge/listAdapters`, `bridge/listSessions`, `ide/getCapabilities`, `workspace/list`, `workspace/get`, `workspace/getStatus`.
- `IDEBP_ROUTED_METHODS` (`application-validation.ts:267-285`) — 17 methods a consumer session may send that are routed to an adapter: `document/read`, `document/getRevision`, `document/getSymbols`, `workspace/searchSymbols`, `workspace/searchTodos`, `workspace/listBookmarks`, `symbol/resolveAt`, `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations`, `symbol/getHierarchy`, `diagnostics/getSnapshot`, `refactor/prepare`, `refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, `workspace/undo`.
- `IDEBPRoutedMethod` (`application-validation.ts:287`) — `(typeof IDEBP_ROUTED_METHODS)[number]`; the union of all 17 routed method names.

### Notification classification constants (`application-validation.ts`)

- `IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS` (`application-validation.ts:289-303`) — 13 notifications an adapter may send: `adapter/capabilitiesChanged`, `workspace/opened`, `workspace/closed`, `workspace/rootsChanged`, `workspace/readinessChanged`, `workspace/trustChanged`, `document/opened`, `document/changed`, `document/saved`, `document/closed`, `document/deleted`, `document/renamed`, `diagnostics/changed`.
- `IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS` (`application-validation.ts:305-308`) — 14 notifications a consumer may receive: all 13 adapter-outbound notifications plus `adapter/disconnected`.

### Validation result types (`*-validation.ts`)

- `IDEBPNotificationValidation` (`application-validation.ts:425-432`) — `{ kind: "valid"; method; notification } | { kind: "unknown" } | { kind: "invalid" }`.
- `HandshakeRequestValidation` (`handshake-validation.ts:54-57`) — `{ kind: "valid"; request } | { kind: "authentication" } | { kind: "invalid" }`.
- `HandshakeServerMessageValidation` (`handshake-validation.ts:85-88`) — `{ kind: "success"; response } | { kind: "error"; response } | { kind: "invalid" }`.

## Key Functions

### Application validation (`application-validation.ts`)

- `isIDEBPApplicationMethod(value: string): value is IDEBPApplicationMethod` (`application-validation.ts:378-380`) — checks if string is a known application method.
- `isIDEBPNotificationMethod(value: string): value is IDEBPNotificationMethod` (`application-validation.ts:382-384`) — checks if string is a known notification method.
- `isIDEBPApplicationRequest<M>(method: M, value: unknown): value is IDEBPApplicationRequestByMethod[M]` (`application-validation.ts:386-391`) — validates a request payload against the schema for method M.
- `isIDEBPApplicationResponse<M>(method: M, value: unknown): value is IDEBPApplicationResponseByMethod[M]` (`application-validation.ts:393-398`) — validates a response payload against the schema for method M.
- `describeApplicationResponseFailure(method: IDEBPApplicationMethod, value: unknown): string | undefined` (`application-validation.ts:409-419`) — returns a short phrase naming the first Ajv keyword and instance path that caused a response to fail its schema, or `undefined` if the response is valid. Never exposes the offending value: a response routinely contains document text, and a close frame is not where that belongs. The boolean `isIDEBPApplicationResponse` says a payload was refused without saying which rule refused it; this function names the rule.
- `isIDEBPJSONRPCErrorResponse(value: unknown): value is IDEBPJSONRPCErrorResponse` (`application-validation.ts:421-423`) — validates a JSON-RPC error response.
- `classifyIDEBPNotification(value: unknown): IDEBPNotificationValidation` (`application-validation.ts:434-447`) — classifies a notification as valid (with method), unknown method, or invalid structure. Checks shape, method field, method name, then runs method-specific validator.

### Handshake validation (`handshake-validation.ts`)

- `classifyBridgeHandshakeRequest(value: unknown): HandshakeRequestValidation` (`handshake-validation.ts:69-75`) — validates handshake request. If all errors are authentication-related (instancePath `/params/authentication` or missing `authentication` property), returns `{ kind: "authentication" }`. Otherwise `{ kind: "invalid" }`. Does not expose Ajv details or token values.
- `isBridgeHandshakeRequest(value: unknown): value is BridgeHandshakeRequest` (`handshake-validation.ts:77-79`) — convenience type guard wrapping `classifyBridgeHandshakeRequest`.
- `isJSONRPCRequestIdentifier(value: unknown): value is JSONRPCRequestIdentifier` (`handshake-validation.ts:81-83`) — validates a JSON-RPC id (non-empty string or integer).
- `classifyBridgeHandshakeServerMessage(value: unknown): HandshakeServerMessageValidation` (`handshake-validation.ts:91-97`) — classifies daemon's first message as success (handshake response), error (error response), or invalid. Does not expose payload details in failures.
- `isBridgeHandshakeResponse(value: unknown): value is BridgeHandshakeResponse` (`handshake-validation.ts:99-101`) — type guard for successful handshake response.
- `isBridgeHandshakeErrorResponse(value: unknown): value is BridgeHandshakeErrorResponse` (`handshake-validation.ts:103-106`) — type guard for handshake error response.

### Discovery validation (`discovery-validation.ts`)

- `assertIDEBPLoopbackEndpoint(endpoint: string): void` (`discovery-validation.ts:15-39`) — throws if endpoint is not `ws://` on `127.0.0.1` or `[::1]`, with `/rpc` pathname, integer port 1–65535, no username/password/search/hash.
- `isIDEBPDiscoveryFile(value: unknown): value is IDEBPDiscoveryFile` (`discovery-validation.ts:41-49`) — schema validation + loopback endpoint assertion. Returns false on any failure.
- `parseIDEBPDiscoveryFile(value: unknown): IDEBPDiscoveryFile` (`discovery-validation.ts:51-57`) — throws with Ajv error summary (instancePath:keyword pairs) if invalid. Returns typed value if valid.

### Workspace URI containment (`workspace-uri.ts`)

- `normalizedUriSegments(pathname: string): string[] | undefined` (`workspace-uri.ts:10-32`) — private helper. Percent-decodes the pathname via `decodeURIComponent`. Rejects NUL bytes (`\u0000`) and backslashes (`\\`). Resolves dot segments: `..` pops (returns `undefined` if popping above root), empty/`.` skipped, other segments pushed. Returns `undefined` on decode failure or traversal escape.
- `isUriWithinWorkspaceRoot(documentUri: string, rootUri: string): boolean` (`workspace-uri.ts:36-57`) — parses both URIs via `new URL()`. Compares `protocol`, `username`, `password`, `host`, `search`, `hash` for exact equality. Normalizes both pathnames via `normalizedUriSegments`. Returns `true` only if every root segment matches the corresponding document segment (root is a prefix). Fail-closed: any parse failure or `undefined` segments → `false`. Never converts URIs to local filesystem paths; the original URI remains the value forwarded on the wire.

### Internal helpers

- `requireValidator(reference: string): ValidateFunction` (`application-validation.ts:352-356`) — gets compiled validator from Ajv or throws if missing.
- `requireValidator<T>(schemaId: string): ValidateFunction<T>` (`handshake-validation.ts:37-41`) — typed variant for handshake validators.
- `refs(schemaId: string, prefix: string): ContractReferences` (`application-validation.ts:310-315`) — builds `{ request, response }` $ref pair from schema ID and definition prefix.
- `eventRef(definition: string): string` (`application-validation.ts:317-319`) — builds notification $ref from events schema ID and definition name.
- `isAuthenticationIssue(error: ErrorObject): boolean` (`handshake-validation.ts:59-66`) — checks if Ajv error is authentication-related by instancePath or missingProperty.

## Data & Control Flow

### Type generation flow

1. `scripts/generate-types.ts` reads all `*.schema.json` from `packages/protocol/schemas/`.
2. Schemas are indexed by `$id` (must start with `https://ide-bridge.dev/schemas/0.1.0/`).
3. Top-level contracts and `$defs` entries are collected into a single `IDEBPProtocolTypes` root schema.
4. `json-schema-to-typescript` compiles the root, resolving `$ref` URIs via custom in-memory resolver (no HTTP).
5. Output is Prettier-formatted and written to `generated.ts` (or checked for staleness with `--check`).

### Runtime validation flow — handshake

1. Daemon receives first WebSocket message → calls `classifyBridgeHandshakeRequest(value)`.
2. Ajv validates against `handshake-request.schema.json`.
3. If valid → `{ kind: "valid", request }` with typed `BridgeHandshakeRequest`.
4. If all errors are authentication-related → `{ kind: "authentication" }` (caller sends `AuthenticationFailed`).
5. Otherwise → `{ kind: "invalid" }` (caller sends `InvalidRequest`).
6. Daemon sends first response → client calls `classifyBridgeHandshakeServerMessage(value)`.
7. If matches `handshake-response.schema.json` → `{ kind: "success" }`.
8. If matches `handshake-error-response.schema.json` → `{ kind: "error" }`.
9. Otherwise → `{ kind: "invalid" }`.

### Runtime validation flow — application requests

1. Consumer sends JSON-RPC request → daemon extracts `method` field.
2. `isIDEBPApplicationMethod(method)` checks if method is known.
3. `isIDEBPApplicationRequest(method, value)` validates against the method's request schema via `requestValidators[method]`.
4. Daemon processes request, builds response.
5. `isIDEBPApplicationResponse(method, value)` validates the response before sending.

### Runtime validation flow — notifications

1. Message arrives → `classifyIDEBPNotification(value)`:
   - Checks object shape (not null/array).
   - Extracts `method` field.
   - If method unknown → `{ kind: "unknown" }`.
   - If method known but schema validation fails → `{ kind: "invalid" }`.
   - If valid → `{ kind: "valid", method, notification }`.
2. Caller checks session-role direction against `IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS` or `IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS`.

### Runtime validation flow — discovery

1. Consumer reads discovery file from disk → calls `parseIDEBPDiscoveryFile(value)`.
2. `isIDEBPDiscoveryFile(value)` runs Ajv schema validation + `assertIDEBPLoopbackEndpoint(endpoint)`.
3. If invalid → throws with error summary (instancePath:keyword pairs from Ajv errors).
4. If valid → returns typed `IDEBPDiscoveryFile` with loopback `ws://` endpoint and token.

### Workspace URI containment flow

1. Caller invokes `isUriWithinWorkspaceRoot(documentUri, rootUri)` with two wire URI strings.
2. `new URL()` parses both. Any parse failure → `false`.
3. Component comparison: `protocol`, `username`, `password`, `host`, `search`, `hash` must all match exactly.
4. `normalizedUriSegments` percent-decodes and resolves dot segments for both pathnames. Any failure → `false`.
5. Root segments checked as prefix of document segments. If root is `["a", "b"]` and document is `["a", "b", "c"]` → `true`. If root is `["a", "b"]` and document is `["a", "b"]` → `true` (document IS the root). If root is `["a", "b"]` and document is `["a", "c"]` → `false`.
6. Original URIs are never modified — normalization is for authorization comparison only.

## Integration Points

- **Consumed by**: `@ide-bridge/bridge-daemon` (server-side validation, workspace URI containment), `@ide-bridge/bridge-client` (client-side validation, method classification for role-based authorization), `vscode-extension` (IDE adapter), `@ide-bridge/jetbrains-plugin` (via Kotlin interop), `@ide-bridge/conformance` (fixture/test validation).
- **Depends on**: `ajv` (2020-12 via `ajv/dist/2020.js`), `ajv-formats` (format validation), `json-schema-to-typescript` (code generation only, in scripts). Runtime imports are schema JSON files from `../schemas/`. `workspace-uri.ts` has zero external dependencies (uses global `URL`, `decodeURIComponent`).
- **External boundaries**:
  - Schema files: `packages/protocol/schemas/**/*.schema.json` (canonical wire contract).
  - Generated types: `packages/protocol/src/generated.ts` (auto-generated, do not edit).
  - Protocol version: `PROTOCOL_VERSION = "0.1.0"` (`index.ts:53`).
  - Protocol constants: `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT` (200), `IDEBP_MAX_SYMBOL_SEARCH_LIMIT` (1000), `IDEBP_MAX_SYMBOL_LOCATIONS` (1000), `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS` (500), `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` (1000) (`index.ts:64-80`).
  - Workspace URI containment: `isUriWithinWorkspaceRoot` exported from `index.ts:51`, re-exported from `workspace-uri.ts`.
  - Schema URI prefix: `https://ide-bridge.dev/schemas/0.1.0/` (used in `$id` and `$ref` resolution).
  - Discovery file endpoint: loopback `ws://` on `/rpc` (`discovery-validation.ts:15-39`).

## Common Gotchas

- **Do not edit `generated.ts` manually.** It is auto-generated from JSON Schema files. Run `pnpm protocol:generate` to regenerate (`generated.ts:1-6`).
- **Three separate Ajv instances.** Each validation module (`application-validation.ts`, `handshake-validation.ts`, `discovery-validation.ts`) creates its own Ajv instance. Do not share validators across modules — they have different schema sets loaded.
- **Method classification constants are `as const satisfies`.** `IDEBP_ADAPTER_ORIGINATED_METHODS`, `IDEBP_CONSUMER_LOCAL_METHODS`, and `IDEBP_ROUTED_METHODS` use `as const satisfies readonly IDEBPApplicationMethod[]` to ensure they are both literal-typed and type-checked against the method union. `IDEBPRoutedMethod` is derived from `IDEBP_ROUTED_METHODS` via `(typeof IDEBP_ROUTED_METHODS)[number]` (`application-validation.ts:251-287`).
- **`IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS` includes `adapter/disconnected`.** It is defined as `[...IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS, "adapter/disconnected"]`. Consumers receive all 13 adapter-outbound notifications plus the daemon-originated `adapter/disconnected` (`application-validation.ts:305-308`).
- **`IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS` includes `workspace/trustChanged`.** There are 13 outbound notifications, not 12 (`application-validation.ts:289-303`).
- **`IDEBPNotificationByMethod` has 15 entries** including `$/cancelRequest` and `adapter/disconnected` (`application-validation.ts:163-179`).
- **Protocol constants are shared, not daemon-local.** `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT`, `IDEBP_MAX_SYMBOL_SEARCH_LIMIT`, `IDEBP_MAX_SYMBOL_LOCATIONS`, `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS`, `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` live in `index.ts:64-80` so adapters and the daemon apply identical bounds. A divergent adapter would emit results the daemon rejects as a policy violation.
- **`isUriWithinWorkspaceRoot` lives in the protocol package, not the daemon.** The rule must be identical on both sides (`workspace-uri.ts:1-6`). The daemon's `security/workspace-uri.ts` is now a 6-line re-export from this package.
- **`classifyBridgeHandshakeRequest` does not leak token info.** It only distinguishes authentication failures from structural failures. The `isAuthenticationIssue` helper checks `instancePath` and `missingProperty` but never accesses the token value (`handshake-validation.ts:59-66`). Do not add error detail that could leak the supplied token.
- **Discovery endpoint must be loopback only.** `assertIDEBPLoopbackEndpoint` enforces `ws://` protocol (not `wss://`), `127.0.0.1` or `[::1]` hostname, `/rpc` pathname, no credentials, no query, no hash. This is a security invariant (`AGENTS.md` §4).
- **`isIDEBPApplicationRequest` mutates Ajv state.** Like all Ajv validators, calling `requestValidators[method](value)` sets `validator.errors`. Do not rely on errors from a previous call after a new validation.
- **Protocol version comparison must use BigInt.** The handshake protocol range uses string comparison via BigInt to handle numeric edge cases. Do not use lexicographic string comparison (`handshake-validation.ts:70-82`).
- **URI values must not be converted to local paths.** Preserve the original URI across all operations. URI mappings are explicit in `IDEBPEndpointTopology`, never inferred (`AGENTS.md` §2, `generated.ts:515-533`).
- **Every edit must carry revision preconditions.** `EditPlan.preconditions` is a non-empty array of `DocumentRevisionPrecondition`. Plans are rejected when preconditions are stale (`AGENTS.md` §5, `generated.ts:716`).
- **Never describe a textual edit as semantic.** `Guarantee` has four levels: `"semantic"`, `"syntactic"`, `"anchored-text"`, `"raw-text"`. A `raw-text` or `anchored-text` operation must never be labelled `semantic` or `syntactic` (`AGENTS.md` §1).
- **`normalizedUriSegments` rejects NUL bytes and backslashes** (`workspace-uri.ts:14-15`) — backslashes are not valid URI path separators and could be used for path confusion attacks on Windows-style paths.
- **`normalizedUriSegments` returns `undefined` if `..` pops above the root** (`workspace-uri.ts:19-21`) — this is a traversal-escape rejection, not a normalization.
- **`isUriWithinWorkspaceRoot` compares full URI components including `search` and `hash`** (`workspace-uri.ts:41-43`) — a document URI with a query string different from the root's will fail containment, even if the path is within the root.
- **`isUriWithinWorkspaceRoot` is fail-closed** (`workspace-uri.ts:55-57`) — the outer `catch` returns `false` for any unexpected error, including `URL` constructor failures.
