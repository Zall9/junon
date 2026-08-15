# packages/bridge-daemon/src/routing/

## Responsibility

Application-layer request routing for the IDE Bridge daemon. The `ApplicationRouter` receives all authenticated JSON-RPC messages, classifies them by role and method, and dispatches accordingly: adapter-local methods (register/unregister/ping), consumer-local methods (status/listing/capabilities), routed methods (forwarded to the adapter owning the target workspace), or plan-store methods (prepare/apply/discard/undo — intercepted for identity translation and validation). Manages route IDs, in-flight limits, timeouts, cancellation, edit-store integration, routed result validation (symbol bounds, document containment, diagnostics caps), and broadcasts adapter notifications to all consumers. Also owns a `MetricsRegistry` for ADR-0035 instrumentation. 1619 lines.

## Design Patterns

- **Router / Dispatcher**: `ApplicationRouter` (`application-router.ts:390`) is the central message handler. `handle()` dispatches to `#handleRequest`, `#handleNotification`, or `#handleResponse` based on message structure.
- **ID Remapping**: Consumer request IDs are replaced with daemon-generated `route_<base64url>` IDs before forwarding to the adapter (`application-router.ts:692`). Adapter responses are remapped back to consumer IDs (`application-router.ts:916`). This prevents ID collisions and hides consumer identity from the adapter.
- **Method Classification Sets**: Four `Set<IDEBPApplicationMethod>` constants partition the method space (`application-router.ts:59-70`):
  - `ADAPTER_REQUEST_METHODS` (`:59`) — from `IDEBP_ADAPTER_ORIGINATED_METHODS`.
  - `CONSUMER_LOCAL_METHODS` (`:60`) — from `IDEBP_CONSUMER_LOCAL_METHODS`.
  - `PLAN_STORE_METHODS` (`:61-67`): `refactor/prepare`, `refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, `workspace/undo`.
  - `ROUTED_METHODS` (`:68-70`): `IDEBP_ROUTED_METHODS` filtered to exclude `PLAN_STORE_METHODS`.
- **Symbol Result/Location Method Sets**: Two additional sets for response validation (`application-router.ts:79-91`):
  - `SYMBOL_RESULT_METHODS` (`:79-83`): `document/getSymbols`, `workspace/searchSymbols`, `symbol/resolveAt` — results carrying symbol trees subject to pre-schema bounding.
  - `SYMBOL_LOCATION_METHODS` (`:84-91`): `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations`, `symbol/getHierarchy` — results carrying symbol locations. A hierarchy step answers with the same shape as a lookup, so it inherits the same containment and handle-authority checks.
- **Route Lifecycle State Machine**: `RouteRecord.state` is `"active" | "cancelled"` (`application-router.ts:117`). Cancellation transitions to `"cancelled"`, sends `$/cancelRequest` to adapter, schedules removal after `CANCELLED_ROUTE_GRACE_MS`.
- **Edit-Store Integration**: `editStore: InMemoryEditStore` is a public readonly field (`application-router.ts:391`). Plan-store methods consume/store plans and undo tokens through it. Public consumer plan/undo IDs are translated to/from private adapter IDs.
- **Edit Operation Discriminated Union**: `RouteRecord.editOperation` (`application-router.ts:131-137`) tracks whether the route is `none`, `prepare`, `apply` (with `StoredPlan`), `discard` (with `StoredPlan`), or `undo` (with `StoredUndoToken`). Response transformation and cleanup dispatch on this tag.
- **Observer / Broadcast**: `#broadcast(notification)` (`application-router.ts:1537`) sends to all consumer connections via `Promise.allSettled`.
- **Error Mapping**: `#sendMappedError` (`application-router.ts:1518`) converts `SessionRegistryError` and `EditStoreError` codes to `SafeErrorCode` responses. Records `this.metrics.recordRefusal(code, method)` attributed to the method (`:1533`) — was previously unattributed; the signature always carried `method` but the call did not pass it, leaving the per-method refusal column empty for every daemon-produced refusal.
- **Pre-Schema Symbol Bounding**: `routedSymbolsWithinBounds` (`application-router.ts:361-388`) walks the symbol tree iteratively (not recursively) to bound depth/count before schema validation, preventing unbounded stack or CPU consumption on a deep or oversized tree.
- **Named Rejection Reasons**: `routedRejectionReason` (`application-router.ts:201-203`) appends the `EditStoreError.reason` to a close reason so an adapter author knows which rule refused a routed result. `editRejectionReason` (`application-router.ts:212-221`) names the failing rule and the operation kind when an edit response transformation is rejected, never the payload. `clampCloseReason` (`application-router.ts:181-191`) truncates close reasons to the 123-byte RFC 6455 limit, respecting code-point boundaries.
- **Response Schema Failure Description**: `#handleResponse` calls `describeApplicationResponseFailure` (`application-router.ts:884`) to name the violated Ajv keyword and instance path when a routed non-error response fails its schema, instead of closing with a bare "invalid" message.

## Key Types

- `ApplicationRouter` (`application-router.ts:390`): Central router class. Public: `editStore: InMemoryEditStore` (`:391`), `metrics: MetricsRegistry` (`:400`). The `metrics` registry is owned here rather than injected: the router is the one place that sees every method, every refusal code and every `truncated` flag (ADR-0035). Private fields: `#registry`, `#startedAt`, `#now`, `#routeTimeoutMs`, `#maxInFlight`, `#maxInFlightPerConsumer`, `#createRouteId`, `#routes: Map<string, RouteRecord>`, `#consumerRequests: Map<string, string>`.
- `RouteRecord` (`application-router.ts:106-125`): `routeId`, `method`, `workspaceId`, optional `targetDocumentUri`, optional `searchLimit`, `consumerId`, `consumerSessionId`, `consumerConnection`, `adapterSessionId`, `adapterConnection`, `state: "active" | "cancelled"`, `expiration: ReturnType<typeof setTimeout>`, `editOperation`.
- `RouteRecord.editOperation` (`application-router.ts:119-124`): Discriminated union — `{ kind: "none" }` | `{ kind: "prepare" }` | `{ kind: "apply"; stored: StoredPlan }` | `{ kind: "discard"; stored: StoredPlan }` | `{ kind: "undo"; stored: StoredUndoToken }`.
- `ApplicationRouterOptions` (`application-router.ts:127-133`): `now?`, `routeTimeoutMs?`, `maxInFlight?`, `maxInFlightPerConsumer?`, `createRouteId?`.
- `SafeErrorCode` (`application-router.ts:93-104`): `RegistryErrorCode` plus `ADAPTER_DISCONNECTED`, `CAPABILITY_UNAVAILABLE`, `CANCELLED`, `INTERNAL_ERROR`, `INVALID_REQUEST`, `PLAN_EXPIRED`, `PLAN_NOT_FOUND`, `PROVIDER_FAILED`, `STALE_SYMBOL`, `TIMEOUT`.
- Constants: `DEFAULT_ROUTE_TIMEOUT_MS = 30_000` (`:72`), `MAX_ROUTE_TIMEOUT_MS = 300_000` (`:73`), `DEFAULT_MAX_IN_FLIGHT = 1_024` (`:74`), `DEFAULT_MAX_IN_FLIGHT_PER_CONSUMER = 128` (`:75`), `CANCELLED_ROUTE_GRACE_MS = 30_000` (`:76`), `MAX_ROUTED_DOCUMENT_SYMBOLS = 5_000` (`:77`), `MAX_ROUTED_SYMBOL_DEPTH = 64` (`:78`), `CLOSE_REASON_LIMIT_BYTES = 123` (`:181`).

## Key Functions

- `handle(connection, value)` (`application-router.ts:436`): Entry point. Calls `registry.touch()`, then classifies as request (has `method` + valid `id`), notification (has `method`, no `id`), or response.
- `sessionClosed(connection, reason)` (`application-router.ts:449`): Calls `editStore.invalidateSession`, closes registry, removes/cancels all routes for that session, broadcasts canonical reason when an adapter was removed.
- `#handleRequest(connection, value)` (`application-router.ts:485`): Validates canonical methods and dispatches by role. Plan-store methods go through `#routeEditRequest`; all others through `#routeRequest` or local handlers.
- `#handleAdapterRequest(connection, method, value, id)` (`application-router.ts:521`): Handles `ide/register`, `ide/unregister` (invalidates edit store + broadcasts `adapter/disconnected` with reason `"shutdown"`), `ide/ping`.
- `#handleConsumerLocalRequest(connection, method, value, id)` (`application-router.ts:568`): Handles `bridge/getStatus`, `bridge/listAdapters`, `bridge/listSessions`, `workspace/list`, `workspace/get`, `workspace/getStatus`, `ide/getCapabilities`.
- `#routeRequest(consumerConnection, method, value, consumerId, editOperation?)` (`application-router.ts:628`): Resolves adapter connection, checks capability (skipped for apply/discard/undo), checks symbol handle staleness, generates route ID, forwards remapped request, sets timeout. Returns `boolean` (success). For `workspace/searchSymbols`, extracts query and records via `this.metrics.recordQuery(query, method)` (`:715-716`).
- `#routeEditRequest(connection, method, value, id)` (`application-router.ts:747`): Intercepts all 5 plan-store methods. For `prepareRename`/`prepare`: delegates to `#routeRequest` with `{ kind: "prepare" }` (`:760` — `refactor/prepare` was previously in `PLAN_STORE_METHODS` but had no case here, so it fell through silently and the consumer waited forever with no response; now routes identically to `prepareRename`). For `applyPlan`/`undo`: checks workspace trust, consumes public authority, translates plan/undo ID, delegates to `#routeRequest` with stored state. For `discardPlan`: consumes plan, translates ID, delegates. On routing failure, releases stored state back to the edit store.
- `#handleResponse(connection, value)` (`application-router.ts:851`): Only adapters may send responses. Looks up the route, pre-bounds document-symbol trees, validates method plus exact document/symbol authority, transforms edit responses, and sends to the consumer. After the routed response is ready, records `this.metrics.recordRefusal(refusal, route.method)` for errors or `this.metrics.recordIncomplete(route.method)` when `truncated === true` (`:953-960`).
- `#transformEditResponse(route, value)` (`application-router.ts:966`): For `prepare`: stores adapter plan via `editStore.createPlan`, returns public plan. For `discard`: validates returned `planId` matches adapter plan, returns public plan ID. For `apply`/`undo`: validates modified documents, creates undo token (omits if store full), returns cloned result with public undo token.
- `#transformEditErrorResponse(route, value)` (`application-router.ts:1024`): Rewrites adapter plan IDs to public plan IDs in error details. Validates `workspaceId` consistency. For `PARTIAL_APPLY` errors, validates modified documents subset.
- `#assertModifiedDocuments(route, modifiedDocuments, plan, requireEveryPlannedDocument)` (`application-router.ts:1062`): Validates before/after hashes, content hash consistency, precondition matching, editor version advancement, no duplicate URIs, content-unchanged check, document containment in workspace. Each rejection condition names itself in the `EditStoreError.reason`. If `requireEveryPlannedDocument`, every planned change URI must appear.
- `#assertWorkspaceDocument(workspaceId, document)` (`application-router.ts:1129`): Validates `document.workspaceId`, `revision.workspaceEpoch`, root existence, and URI containment via `isUriWithinWorkspaceRoot`; shared by edits, document route results, and document notifications. Each rejection condition names itself in the `EditStoreError.reason`.
- `#assertRoutedDocumentResult(route, value)` (`application-router.ts:1157`): Dispatches per method: `workspace/searchSymbols` → `#assertRoutedSearchSymbols`; symbol location methods (including `symbol/getHierarchy`) → `#assertRoutedSymbolLocations`; `diagnostics/getSnapshot` → `#assertRoutedDiagnostics`; `document/read`/`getRevision`/`getSymbols`/`symbol/resolveAt` → document URI match + `#assertWorkspaceDocument` + optional symbol validation.
- `#assertRoutedSymbolLocations(route, locations)` (`application-router.ts:1207`): Validates that each location URI is within a registered root, caps at `IDEBP_MAX_SYMBOL_LOCATIONS`, validates optional symbol handles (adapterId, sessionId, validUntilEpoch, unique handle IDs, locator URI containment).
- `#assertRoutedDocumentSymbols(route, symbols)` (`application-router.ts:1237`): Iteratively validates symbol tree: each handle must match workspace adapter/session/current epoch, be unique, point to the target document URI, and stay within a registered root. Bounded at `MAX_ROUTED_DOCUMENT_SYMBOLS` (5000) and `MAX_ROUTED_SYMBOL_DEPTH` (64).
- `#assertRoutedSearchSymbols(route, symbols)` (`application-router.ts:1279`): Validates workspace search results: flat (no children), each symbol owned by routed adapter/session/current epoch, unique handles, each locator URI within a registered root. Capped at the effective request limit (`route.searchLimit`).
- `#assertRoutedDiagnostics(route, documents)` (`application-router.ts:1311`): Caps documents at `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS` (500), caps diagnostics per document at `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` (1000), rejects duplicate document URIs, validates each document via `#assertWorkspaceDocument`, validates related-information locations via `#assertWorkspaceUri`.
- `#handleNotification(connection, value)` (`application-router.ts:1340`): Validates via `classifyIDEBPNotification`. Handles `$/cancelRequest` from consumers. Adapter notifications are applied to registry then broadcast to consumers.
- `#applyAdapterNotification(sessionId, method, params)` (`application-router.ts:1379`): Applies registry mutations and invalidation, and validates document event roots, epochs, containment, and rename URIs before broadcast.
- `#removeRoute(route)` (`application-router.ts:1582`): Clears timeout, deletes from `#routes` and `#consumerRequests`. Releases edit-store entries: `apply`/`discard` → `releasePlan`, `undo` → `releaseUndoToken`.
- `#assertStoredAdapter(adapterSessionId, workspaceId)` (`application-router.ts:1610`): Throws `PLAN_EXPIRED` if the stored plan's adapter session no longer owns the workspace.
- `close()` (`application-router.ts:1616`): Calls `editStore.close()` to stop the sweep timer.
- `createErrorResponse(id, code, details?)` (`application-router.ts:224`): Builds `IDEBPJSONRPCErrorResponse`. `retryable` is `true` only for `TIMEOUT` and `ADAPTER_DISCONNECTED` (`:237`).
- `routedSymbolsWithinBounds(value)` (`application-router.ts:361-388`): Pre-schema bounding. Iteratively walks symbol trees (not recursive) up to `MAX_ROUTED_DOCUMENT_SYMBOLS` (5000) nodes and `MAX_ROUTED_SYMBOL_DEPTH` (64) depth. Also caps location arrays at `IDEBP_MAX_SYMBOL_LOCATIONS`. Returns `false` if exceeded.
- `editorVersionAdvanced(precondition, revision)` (`application-router.ts:339-346`): Returns `true` if either side lacks an `editorVersion` (file on disk has none, ADR-0020); otherwise checks `revision.editorVersion > precondition.editorVersion`.
- `requestSymbolHandle(request)` (`application-router.ts:312-331`): Extracts `{ adapterId, sessionId, validUntilEpoch }` from a request's `symbol.handle` field for staleness checking.
- `requestSearchQuery(request): string | undefined` (`application-router.ts:275-283`): Extracts `query` from `workspace/searchSymbols` params for metrics recording.
- `refusalCode(response): string | undefined` (`application-router.ts:285-293`): Extracts normalized error code from a JSON-RPC error response.
- `carriesTruncation(response): boolean` (`application-router.ts:296-301`): Checks whether `result.truncated === true`.
- `requestSearchLimit(request)` (`application-router.ts:348-355`): Extracts the effective search limit from a `workspace/searchSymbols` request, defaulting to `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT` and capping at `IDEBP_MAX_SYMBOL_SEARCH_LIMIT`.
- `mutableMetrics(snapshot)` (`application-router.ts:264-272`): Converts the `MetricsSnapshot`'s `readonly` arrays to mutable copies for the `status()` response. Copied rather than cast — a reader must not be able to mutate the daemon's counters by holding its snapshot; a cast would have thrown that away to save four lines.
- `status()` (`application-router.ts:1492-1503`): Returns daemon status object including `daemonVersion`, `protocol`, `startedAt`, `uptimeMs`, `adapterCount`, `workspaceCount`, `sessionCount`, and `metrics: mutableMetrics(this.metrics.snapshot())`. The metrics ride here rather than behind a new method because a new method name is compared against the Kotlin catalogue, which would have made a read-only local counter a cross-language protocol change. Optional in the schema, so a daemon keeping no counters omits the field instead of reporting zeroes that read like an idle daemon.
- `clampCloseReason(reason)` (`application-router.ts:181-191`): Truncates close reasons to the 123-byte RFC 6455 close-frame payload limit, respecting UTF-8 code-point boundaries.
- `routedRejectionReason(summary, error)` (`application-router.ts:201-203`): Appends `EditStoreError.reason` to a summary string when a routed non-edit result is refused, then clamps to the close-frame limit.
- `editRejectionReason(method, operation, error)` (`application-router.ts:212-221`): Names the failing rule and operation kind when an edit response transformation is rejected, never the payload. Carries `EditStoreError.code` and `reason`, or a truncated generic message.

## Data & Control Flow

**Request routing (consumer → adapter)**:

1. Consumer sends `{"method": "document/read", "id": 42, "params": {"workspaceId": "ws1", ...}}`.
2. `handle()` → `#handleRequest()` → `#routeRequest()`.
3. `requestWorkspaceId(request)` extracts `workspaceId` from params.
4. Check in-flight limits: global (`maxInFlight`), per-consumer (`maxInFlightPerConsumer`), duplicate key.
5. `registry.getWorkspaceConnection(workspaceId)` → adapter `AuthenticatedTransportConnection`.
6. Capability check (skipped for `apply`/`discard`/`undo` operations) (`:663-675`).
7. `requestSymbolHandle(request)` → check staleness: `handle.adapterId !== workspace.adapterId` OR `handle.sessionId !== adapterConnection.session.sessionId` OR `handle.validUntilEpoch < workspace.workspaceEpoch` → reject with `STALE_SYMBOL` (`:676-690`).
8. Generate `routeId` via `#nextRouteId()`. Forwarded request: `{ ...value, id: routeId }`.
9. `RouteRecord` stored in `#routes` (keyed by routeId) and `#consumerRequests` (keyed by `requestKey`).
10. `adapterConnection.send(forwarded)` — on failure, send `ADAPTER_DISCONNECTED` to consumer.

**Plan-store request routing (consumer → adapter)**:

1. Consumer sends `{"method": "workspace/applyPlan", "id": 7, "params": {"planId": "public-uuid", "workspaceId": "ws1"}}`.
2. `handle()` → `#handleRequest()` → `#routeEditRequest()` (matches `PLAN_STORE_METHODS`).
3. For `applyPlan`: check workspace trust → `editStore.consumePlan(publicPlanId, ...)` → `#assertStoredAdapter` → translate `planId` to `stored.adapterPlan.planId` → `#routeRequest` with `{ kind: "apply", stored }` (`:764-792`).
4. On routing failure: `editStore.releasePlan(stored)` (restores consumed authority) (`:787`).
5. Adapter response → `#handleResponse` → `#transformEditResponse`: validate modified documents, create undo token → return public plan/undo IDs to consumer.

**Response routing (adapter → consumer)**:

1. Adapter sends `{"id": "route_abc", "result": {...}}`.
2. `handle()` → `#handleResponse()`. Only adapters may send responses; consumers get closed with `1002` (`:807-810`).
3. Look up route by `id` (route ID) in `#routes`. Validate `route.adapterSessionId === connection.session.sessionId`.
4. For `SYMBOL_RESULT_METHODS` or `SYMBOL_LOCATION_METHODS`: `routedSymbolsWithinBounds(value)` pre-schema check. If exceeds bounds → `PROVIDER_FAILED` to consumer, close adapter with `1008` (`:871-885`).
5. Schema validation: `isIDEBPJSONRPCErrorResponse` or `isIDEBPApplicationResponse(route.method, value)`. If the response fails its schema, `describeApplicationResponseFailure` names the violated keyword and instance path in the close reason (`:884-893`).
6. `#assertRoutedDocumentResult(route, value)` — method-specific routed result validation (`:1157`).
7. `#removeRoute(route)`. If `route.state === "cancelled"`, silently discard (`:865-866`).
8. If `editOperation.kind !== "none"`: transform response. On transform failure: send `PROVIDER_FAILED` to consumer, close adapter connection with `1008` and a named rejection reason via `editRejectionReason` (`:916-931`).
9. Validate transformed response shape. On shape mismatch: send `PROVIDER_FAILED`, close adapter with `1008` (`:934-948`).
10. Remap: `{ ...value, id: route.consumerId }` → send to `route.consumerConnection`.

**Session close**:

1. `sessionClosed(connection, reason)` → `editStore.invalidateSession(sessionId)` → `registry.close()` → returns `RemovedSession`.
2. For each route where adapter disconnected: `#removeRoute` + send `ADAPTER_DISCONNECTED` to consumer.
3. For each route where consumer disconnected: `#cancelRoute` (graceful).
4. If adapter was removed: broadcast `adapter/disconnected` with canonical reason.

**Edit-store invalidation on notifications** (`#applyAdapterNotification`, `:1379-1479`):

- `workspace/closed` → `editStore.invalidateWorkspace(workspaceId)` (`:1397`).
- `workspace/rootsChanged` → `editStore.invalidateWorkspace(workspaceId)` (`:1403`).
- `document/changed` → `editStore.invalidateDocument(workspaceId, uri)` (`:1445`).
- `document/deleted` → `editStore.invalidateDocument(workspaceId, uri)` (`:1434`). Validated by URI containment alone — no revision (ADR-0022).
- `document/renamed` → `editStore.invalidateDocument(workspaceId, previousUri)` + `invalidateDocument(workspaceId, document.uri)` (`:1457-1458`). Both URIs validated.
- `ide/unregister` → `editStore.invalidateSession(sessionId)` (`:541`).

**Notification validation** (`#applyAdapterNotification`, `:1379-1479`):

- `document/deleted`: `assertWorkspaceOwnership` + `#assertWorkspaceUri` (URI containment only, no revision) (`:1428-1435`).
- `document/opened`/`changed`/`saved`/`closed`: `assertWorkspaceOwnership` + `#assertWorkspaceDocument` (full revision check) (`:1437-1447`).
- `document/renamed`: both URIs validated — `#assertWorkspaceDocument` for the new URI, `#assertWorkspaceUri` for `previousUri` (`:1449-1459`).
- `diagnostics/changed`: `assertWorkspaceOwnership` + `#assertWorkspaceUri(documentUri)` + epoch match (`typed.revision.workspaceEpoch === workspace.workspaceEpoch`) (`:1461-1473`).
- `workspace/trustChanged`: `registry.updateWorkspaceTrust` (updates ONLY trust field, ADR-0022) (`:1418-1426`).

## Integration Points

- **Consumed by**: `IDEBPDaemonServer` (`daemon-server.ts`) constructs and owns the router. Calls `handle()`, `sessionClosed()`, and `close()`.
- **Depends on**: `@ide-bridge/protocol` (method validators, type guards, `describeApplicationResponseFailure`, `PROTOCOL_VERSION`, `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT`, `IDEBP_MAX_SYMBOL_SEARCH_LIMIT`, `IDEBP_MAX_SYMBOL_LOCATIONS`, `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS`, `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT`), `../plan/in-memory-edit-store.js` (`EditStoreError`, `InMemoryEditStore`, `StoredPlan`, `StoredUndoToken`), `../observability/metrics-registry.js` (`MetricsRegistry`), `../security/workspace-uri.js` (`isUriWithinWorkspaceRoot` — re-export from protocol), `../session/session-registry.js` (`SessionRegistry`, `SessionRegistryError`, `RegistryErrorCode`), `../transport/transport.js` (`AuthenticatedTransportConnection`, `SessionCloseReason`), `../metadata.js` (`DAEMON_VERSION`), `node:crypto` (`randomBytes`).
- **External boundaries**: No direct I/O. All sends go through `AuthenticatedTransportConnection.send()`. Route IDs are `route_<base64url>` strings. Request keys are `${sessionId}\u0000${typeof id}:${String(id)}` (`application-router.ts:244-246`).

## Common Gotchas

- Cancelled route responses are silently discarded (`application-router.ts:865-866`) — the adapter may still send a response after cancellation; it is accepted (route is removed) but not forwarded to the consumer.
- `PLAN_STORE_METHODS` are excluded from `ROUTED_METHODS` (`application-router.ts:61-70`) — they go through `#routeEditRequest`, never through blind `#routeRequest` forwarding.
- `PLAN_STORE_METHODS` are integrated with the bounded edit store: public/private identity rewriting, atomic consumption (consume → route → release on failure), trust checks, and result validation.
- Only adapters may send responses; if a consumer sends a JSON-RPC response, the connection is closed with code `1002` (`application-router.ts:807-810`).
- `adapter/disconnected` notification from an adapter is explicitly rejected (`application-router.ts:1362-1364`) — only the daemon broadcasts it.
- The route timeout timer is `.unref()`-ed (`application-router.ts:707-708`) — it won't keep the process alive.
- `#consumerRequests` is a reverse index: `requestKey(consumerSessionId, consumerId)` → `routeId`. This enables `$/cancelRequest` lookup by consumer.
- `requestKey` uses `\u0000` (null byte) as a separator (`application-router.ts:244-246`) to prevent sessionId/id collision ambiguity.
- The `handle()` method always calls `registry.touch()` first (`application-router.ts:437`) — even for invalid messages — updating `lastActivityAt`.
- `#broadcast` uses `Promise.allSettled` (`application-router.ts:1538-1543`) — individual consumer send failures are silently swallowed.
- `#handleNotification` closes the connection with `1002` for invalid notifications (`application-router.ts:1346`) and `1008` for unauthorized ones (`application-router.ts:1351,1363`).
- **Symbol handle staleness check**: a request handle with the wrong adapter/session or `validUntilEpoch < workspaceEpoch` is rejected with `STALE_SYMBOL` before routing (`:676-690`). New document symbol results must use exactly the current epoch and the routed physical adapter session.
- **`createErrorResponse` marks `TIMEOUT` and `ADAPTER_DISCONNECTED` as `retryable: true`** (`application-router.ts:237`) — all other errors are `retryable: false`.
- **`#transformEditResponse` for `apply` omits the undo token if the edit store is full** (`application-router.ts:1008-1012`) — applying already succeeded, so the success is returned without unsafe undo authority rather than hiding it or exposing the adapter's private token.
- **`#removeRoute` releases edit-store entries** (`application-router.ts:1582-1591`) — plans and undo tokens are returned to the store when a route is removed, preventing leaks.
- **`#assertStoredAdapter` throws `PLAN_EXPIRED`** (`application-router.ts:1610-1613`) if the adapter that created the plan no longer owns the workspace — this catches adapter reconnection or workspace re-registration between prepare and apply.
- **`editorVersionAdvanced` returns `true` if either side lacks `editorVersion`** (`application-router.ts:339-346`) — a file on disk has no editor version (ADR-0020), so comparing an absent version against a present one would reject correct results.
- **`routedSymbolsWithinBounds` walks iteratively, not recursively** (`application-router.ts:361-388`) — prevents stack overflow on deep symbol trees; bounded at 5000 nodes / 64 depth.
- **`#assertRoutedSearchSymbols` requires flat results** (`application-router.ts:1279-1304`) — workspace search symbols must have no children (`symbol.children.length > 0` → reject), unlike document symbols which are trees.
- **`#assertRoutedDiagnostics` rejects duplicate document URIs** (`application-router.ts:1320-1322`) — a snapshot must not carry the same document twice.
- **`#assertModifiedDocuments` names every rejection condition** (`application-router.ts:1062-1127`) — each check throws an `EditStoreError` with a `reason` string identifying the specific rule that failed (duplicate URI, unplanned document, hash mismatch, editor version not advanced, content unchanged, missing planned documents). These reasons propagate into close-frame reasons via `routedRejectionReason` and `editRejectionReason`.
- **`#assertWorkspaceDocument` names every rejection condition** (`application-router.ts:1129-1155`) — each check throws with a specific reason (wrong workspace, stale epoch, unknown root, URI outside root).
- **`#handleResponse` uses `describeApplicationResponseFailure` to name schema violations** (`application-router.ts:884-893`) — the close reason includes the violated Ajv keyword and instance path, never the offending value.
- **`close()` only closes the edit store** (`application-router.ts:1616-1618`) — it does not clear routes or cancel in-flight requests; the transport is responsible for closing connections which triggers `sessionClosed`.
