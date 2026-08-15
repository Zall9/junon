# packages/bridge-daemon/src/plan/

## Responsibility

Provides the in-memory store that backs the daemon's two-phase edit (prepare → apply)
transaction model. `InMemoryEditStore` translates between public plan/undo-token IDs
(issued to consumers) and adapter-private IDs (issued by IDE adapters), enforces
TTL expiration, capacity limits, URI containment within workspace roots, and
automatic invalidation when documents, workspaces, or sessions change. It holds
plans and undo tokens transiently — nothing is persisted to disk. Every stored
object is deep-cloned on ingress and egress via `structuredClone` so the store's
internal state is never aliased by callers (`structured-logger.ts` peer pattern:
observational isolation).

## Design Patterns

- **ID Translation / Pseudonymization**: Public-facing plan IDs and undo-token IDs
  are freshly minted by the store; adapter-private IDs are kept in parallel
  (`StoredPlan.adapterPlan` vs `StoredPlan.publicPlan`). Consumers never see
  adapter IDs and adapters never see consumer IDs. The router rewrites IDs in
  both directions during routing (`application-router.ts:553-559`,
  `application-router.ts:606-608`).
- **Atomic Consume-then-Release**: `consumePlan` and `consumeUndoToken` atomically
  delete the public-facing entry but leave the internal-adapter-key entry alive.
  The caller (router) must explicitly call `releasePlan` / `releaseUndoToken`
  after the adapter round-trip completes or fails. This prevents plan reuse
  while allowing the adapter's internal handle to be cleaned up deterministically
  (`in-memory-edit-store.ts:230`, `in-memory-edit-store.ts:307`).
- **NUL-Separated Composite Keys**: Internal adapter-side keys combine session ID
  and adapter plan/undo ID with a `\u0000` separator (`internalPlanKey`,
  `in-memory-edit-store.ts:77-83`) to prevent cross-session ID collisions without
  a nested `Map`.
- **Background Sweep**: A `setInterval` timer (default 30 s, `.unref()`'d) calls
  `sweep()` to evict expired entries. `createPlan` and `createUndoToken` also
  call `sweep()` synchronously before inserting, ensuring capacity checks
  operate against a fresh set (`in-memory-edit-store.ts:131-134`,
  `in-memory-edit-store.ts:146`).
- **Deny-by-Default Validation**: Every field on the incoming adapter plan/token
  is validated — adapter ID, session ID, workspace ID must match the creation
  context; expiration must be finite and in the future; preconditions must be
  unique by URI, match `workspaceEpoch`, and be within a workspace root; changes
  must be unique by URI and have a matching precondition (`in-memory-edit-store.ts:148-183`).
- **Defensive Copying**: `structuredClone` is used on every ingress and egress
  path (`in-memory-edit-store.ts:191-206`, `in-memory-edit-store.ts:230-231`,
  `in-memory-edit-store.ts:248`, `in-memory-edit-store.ts:275-290`,
  `in-memory-edit-store.ts:315`). The store never holds references to objects
  passed in or returned.

## Key Types

- `InMemoryEditStore` (`in-memory-edit-store.ts:95-420`): The store class itself.
  Holds four private collections: `#plans: Map<string, StoredPlan>`,
  `#internalPlans: Set<string>` (adapter-side plan keys, NUL-separated),
  `#undoTokens: Map<string, StoredUndoToken>`,
  `#internalUndoTokens: Set<string>` (adapter-side undo-token keys).
- `StoredPlan` (`in-memory-edit-store.ts:31-37`): Paired public and adapter
  plans plus session binding and workspace epoch. Fields: `publicPlan: EditPlan`,
  `adapterPlan: EditPlan`, `consumerSessionId: SessionId`,
  `adapterSessionId: SessionId`, `workspaceEpoch: number`.
- `StoredUndoToken` (`in-memory-edit-store.ts:39-44`): Paired public and adapter
  undo tokens plus session binding. Fields: `publicToken: UndoToken`,
  `adapterToken: UndoToken`, `consumerSessionId: SessionId`,
  `adapterSessionId: SessionId`.
- `PlanCreationContext` (`in-memory-edit-store.ts:46-53`): Context for creating a
  plan — binds consumer session, adapter session, adapter ID, workspace ID,
  workspace epoch, and `workspaceRootUris: readonly string[]` for URI containment
  checks.
- `UndoCreationContext` (`in-memory-edit-store.ts:55-60`): Similar to
  `PlanCreationContext` but without workspace epoch and root URIs (undo tokens
  don't carry preconditions).
- `InMemoryEditStoreOptions` (`in-memory-edit-store.ts:62-70`): Configuration —
  `now` (clock injection for tests), `maximumPlanLifetimeMs` (TTL cap, default
  5 min), `maximumEntries` (global cap, default 1024), `maximumEntriesPerConsumer`
  (default 128), `sweepIntervalMs` (default 30 s), `createPlanId` /
  `createUndoTokenId` (ID factory injection for tests).
- `EditStoreError` (`in-memory-edit-store.ts:10-29`): Error class with a
  `code: EditStoreErrorCode` field and an optional `reason: string | undefined`
  field. The `reason` names the specific condition that failed, so adapter
  authors can act on it. It never carries document content: a refusal usually
  concerns a document, and its text must not travel in an error. Codes:
  `PLAN_EXPIRED`, `PLAN_NOT_FOUND`, `PRECONDITION_FAILED`, `PROVIDER_FAILED`.
- `EditStoreErrorCode` (`in-memory-edit-store.ts:7-8`): Union of the four error
  codes above.

## Key Functions

- `createPlan(adapterPlan, context): EditPlan` (`in-memory-edit-store.ts:145-207`):
  Validates adapter plan fields against context, checks capacity, mints a public
  plan ID, caps expiration at `maximumPlanLifetimeMs`, stores both public and
  adapter copies, returns a clone of the public plan. Throws `PROVIDER_FAILED`
  on any field mismatch, duplicate precondition URI, URI outside workspace root,
  or duplicate adapter plan ID. Throws `PRECONDITION_FAILED` on capacity
  overflow.
- `consumePlan(planId, consumerSessionId, workspaceId, workspaceEpoch): StoredPlan`
  (`in-memory-edit-store.ts:209-232`): Looks up by public plan ID, verifies
  consumer session and workspace match. If expired or workspace epoch is stale,
  deletes the plan and throws `PLAN_EXPIRED`. Otherwise atomically deletes the
  public entry (but keeps the internal adapter key) and returns a clone of the
  stored plan. The caller must later call `releasePlan` to clean up the adapter
  key.
- `discardPlan(planId, consumerSessionId, workspaceId): StoredPlan`
  (`in-memory-edit-store.ts:234-249`): Same as `consumePlan` but does not check
  workspace epoch. Used for explicit `workspace/discardPlan` requests.
- `releasePlan(stored): void` (`in-memory-edit-store.ts:251-253`): Deletes the
  internal adapter-side plan key. Called by the router after the adapter
  round-trip completes (success, error, or cancellation).
- `createUndoToken(adapterToken, context): UndoToken`
  (`in-memory-edit-store.ts:255-291`): Validates adapter token fields, mints a
  public undo-token ID, caps expiration, stores both copies. Same error
  semantics as `createPlan`.
- `consumeUndoToken(token, consumerSessionId, workspaceId): StoredUndoToken`
  (`in-memory-edit-store.ts:293-316`): Looks up by public token ID, verifies
  consumer session, workspace, and full token equality (`undoTokensEqual`).
  Atomically deletes the public entry, returns a clone. If expired, releases the
  internal key and throws `PLAN_EXPIRED`.
- `releaseUndoToken(stored): void` (`in-memory-edit-store.ts:318-322`): Deletes
  the internal adapter-side undo-token key.
- `invalidateDocument(workspaceId, uri): number` (`in-memory-edit-store.ts:324-330`):
  Deletes all plans whose preconditions reference the given URI in the given
  workspace. Returns the count of invalidated plans. Called on `document/changed`,
  `document/deleted`, `document/renamed` notifications (`application-router.ts:1381`).
- `invalidateWorkspace(workspaceId): number` (`in-memory-edit-store.ts:332-340`):
  Deletes all plans and undo tokens for a workspace. Called on `workspace/closed`
  and `workspace/rootsChanged` notifications (`application-router.ts:1333,1339`).
- `invalidateSession(sessionId): void` (`in-memory-edit-store.ts:342-351`):
  Deletes all plans and undo tokens owned by or bound to the given session
  (either consumer or adapter side). Called on session close and adapter
  unregister (`application-router.ts:397,484`).
- `sweep(): void` (`in-memory-edit-store.ts:353-364`): Evicts all expired plans
  and undo tokens. Called by the background timer and at the start of every
  `createPlan` / `createUndoToken`.
- `close(): void` (`in-memory-edit-store.ts:366-372`): Clears the sweep timer and
  all four collections. Called by `ApplicationRouter.close()`
  (`application-router.ts:1522-1524`).
- `internalPlanKey(sessionId, planId): string` (`in-memory-edit-store.ts:77-79`):
  Builds `\`${sessionId}\u0000${planId}\`` — the adapter-side composite key.
- `internalUndoTokenKey(sessionId, tokenId): string` (`in-memory-edit-store.ts:81-83`):
  Same pattern for undo tokens.
- `undoTokensEqual(left, right): boolean` (`in-memory-edit-store.ts:85-93`):
  Structural equality on all five `UndoToken` fields. Used in `consumeUndoToken`
  to ensure the consumer's token matches the stored one exactly.
- `#assertCapacity(consumerSessionId): void` (`in-memory-edit-store.ts:374-385`):
  Checks both global (`#maximumEntries`) and per-consumer
  (`#maximumEntriesPerConsumer`) limits across plans + undo tokens combined.
  Throws `PRECONDITION_FAILED` on overflow.
- `#uniqueId(prefix, factory, map): string` (`in-memory-edit-store.ts:387-399`):
  Retries the ID factory up to 16 times, validating format (`^prefix_[A-Za-z0-9_-]+$`,
  max 128 chars) and absence from the target map. Throws on exhaustion.
- `#deletePlan(stored, releaseInternalPlan = true): void` (`in-memory-edit-store.ts:401-404`):
  Deletes the public plan entry; optionally releases the internal adapter key
  via `releasePlan`. Called by `consumePlan`/`discardPlan` with `releaseInternalPlan=false`
  to keep the adapter key alive until `releasePlan` is called.
- `#deleteUndoToken(id, stored): void` (`in-memory-edit-store.ts:406-409`):
  Deletes the public undo-token entry and releases the internal adapter key.
- `#invalidatePlans(predicate): number` (`in-memory-edit-store.ts:411-419`):
  Iterates all plans, deleting those matching the predicate via `#deletePlan`.
  Returns the count of invalidated plans. Shared by `invalidateDocument`,
  `invalidateWorkspace`, `invalidateSession`, and `sweep`.

## Data & Control Flow

1. **Plan creation (prepare phase)**: An adapter responds to
   `refactor/prepareRename` with an `EditPlan` containing adapter-private IDs.
   The router's `#transformEditResponse` calls `editStore.createPlan(adapterPlan,
context)`, passing consumer/adapter session IDs, workspace metadata, and root
   URIs (`application-router.ts:908-916`). The store validates all fields, mints
   a public plan ID, caps the TTL, deep-clones both copies, and returns the
   public plan. The router sends the public plan to the consumer.

2. **Plan consumption (apply/discard phase)**: A consumer sends
   `workspace/applyPlan` or `workspace/discardPlan` with a public plan ID. The
   router calls `editStore.consumePlan(...)` or `discardPlan(...)`
   (`application-router.ts:716-755`). The store atomically removes the public
   entry, returns the stored plan, and the router rewrites the plan ID to the
   adapter-private ID before forwarding to the adapter. If routing fails, the
   router calls `releasePlan` to clean up the internal key
   (`application-router.ts:732`, `application-router.ts:756-759`).

3. **Undo token creation**: After a successful `workspace/applyPlan`, the adapter
   returns a `ModificationResult` with an optional `undoToken`. The router's
   `#transformEditResponse` calls `editStore.createUndoToken(...)` to mint a
   public undo token (`application-router.ts:937-948`). If the store is full
   (`PRECONDITION_FAILED`), the undo token is silently omitted rather than
   hiding the successful modification or exposing the adapter's private token
   (`application-router.ts:944-948`).

4. **Undo token consumption**: A consumer sends `workspace/undo` with a public
   undo token. The router calls `editStore.consumeUndoToken(...)`, rewrites the
   token to the adapter-private version, and forwards (`application-router.ts:770-790`).

5. **Invalidation**: When documents change (`document/changed`,
   `document/deleted`, `document/renamed`), the router calls
   `invalidateDocument` to evict plans whose preconditions are now stale
   (`application-router.ts:1370,1381,1393-1394`). When workspaces close or roots change,
   `invalidateWorkspace` evicts everything for that workspace
   (`application-router.ts:1333,1339`). When sessions close or adapters
   unregister, `invalidateSession` evicts everything bound to that session
   (`application-router.ts:397,484`).

6. **Background sweep**: Every 30 s (default), the timer calls `sweep()` to
   evict expired entries. The timer is `.unref()`'d so it does not keep the
   process alive (`in-memory-edit-store.ts:131-134`).

## Integration Points

- **Consumed by**: `ApplicationRouter` (`routing/application-router.ts`) owns and
  exclusively operates the `InMemoryEditStore` instance. `IDEBPDaemonServer`
  (`daemon-server.ts:35`) constructs the router, which in turn constructs the
  store. The store is re-exported from the package public API
  (`index.ts:16`).
- **Depends on**:
  - `@ide-bridge/protocol` — types only: `AdapterId`, `EditPlan`, `SessionId`,
    `UndoToken`, `WorkspaceId` (`in-memory-edit-store.ts:3`).
  - `../security/workspace-uri.js` — `isUriWithinWorkspaceRoot` for URI
    containment validation of preconditions and changes
    (`in-memory-edit-store.ts:5`, used at `:154-156`, `:167`).
  - `node:crypto` — `randomBytes` for default ID factories
    (`in-memory-edit-store.ts:1`).
- **External boundaries**:
  - No HTTP routes, no env vars, no file paths. Purely in-memory.
  - The store's lifecycle is tied to `ApplicationRouter`, which is tied to
    `IDEBPDaemonServer`. `ApplicationRouter.close()` calls `editStore.close()`
    (`application-router.ts:1522-1524`).
  - ID format: public plan IDs match `^plan_[A-Za-z0-9_-]+$`, public undo-token
    IDs match `^undo_[A-Za-z0-9_-]+$`, both max 128 chars
    (`in-memory-edit-store.ts:391-394`). Default factories use
    `randomBytes(18).toString("base64url")` (`in-memory-edit-store.ts:114-117`).

## Common Gotchas

- **Consume does not release**: `consumePlan` and `consumeUndoToken` delete the
  public-facing entry but leave the adapter-side internal key alive. The caller
  MUST call `releasePlan` / `releaseUndoToken` afterward, or the internal key
  leaks (counted against capacity until sweep evicts it). The router handles
  this in `#removeRoute` (`application-router.ts:1488-1497`) and in error paths
  (`application-router.ts:732`, `application-router.ts:756-759`,
  `application-router.ts:785-788`).
- **TTL is capped, not echoed**: The store caps `expiresAt` at
  `maximumPlanLifetimeMs` (default 5 min) from creation time, even if the
  adapter offered a longer lifetime. The public plan's `expiresAt` is always
  the store's capped value, not the adapter's original
  (`in-memory-edit-store.ts:188-190`, `in-memory-edit-store.ts:279-282`).
- **Per-consumer limit spans plans AND undo tokens**: `#assertCapacity` counts
  plans + undo tokens together against both the global (1024) and per-consumer
  (128) limits (`in-memory-edit-store.ts:374-385`). A consumer with 128 plans
  cannot create an undo token.
- **Per-consumer limit must not exceed global**: The constructor throws if
  `maximumEntriesPerConsumer > maximumEntries` (`in-memory-edit-store.ts:128-130`).
  This invariant must be preserved by any future configuration changes.
- **Undo token equality is structural**: `consumeUndoToken` requires the
  consumer's token to match the stored public token on all five fields
  (`id`, `adapterId`, `sessionId`, `workspaceId`, `expiresAt`) via
  `undoTokensEqual` (`in-memory-edit-store.ts:85-93`, `:298-304`). A token with a
  mismatched `expiresAt` will be rejected as `PLAN_NOT_FOUND`.
- **Sweep runs synchronously in create paths**: `createPlan` and
  `createUndoToken` call `sweep()` before inserting (`in-memory-edit-store.ts:146`,
  `:256`). This means a high-frequency creation rate triggers synchronous
  iteration over all entries on each call. The default 1024 cap bounds this cost.
- **structuredClone everywhere**: The store never returns or stores references to
  mutable objects passed in. Every return path deep-clones. Callers can mutate
  returned objects freely. Conversely, mutating objects passed in after the call
  has no effect on stored state.
- **NUL byte in composite keys**: Internal keys use `\u0000` as a separator
  (`in-memory-edit-store.ts:77-83`). This is safe because session IDs and
  plan/undo IDs are validated to match `^..._[A-Za-z0-9_-]+$` and never contain
  NUL bytes. Do not change the ID format validation without considering the
  separator invariant.
- **No persistence**: All plans and undo tokens are lost on process restart.
  The store is purely in-memory. Long-lived plans are capped at 5 minutes
  anyway, so this is by design.
- **`EditStoreError.reason` names the failing condition**: The `reason` field
  (`in-memory-edit-store.ts:14-28`) carries a short phrase identifying which
  rule rejected the operation. The router propagates it into close-frame
  reasons via `routedRejectionReason` and `editRejectionReason`
  (`application-router.ts:199-220`). It never carries document content.
- **`#deletePlan` with `releaseInternalPlan=false`**: `consumePlan` and
  `discardPlan` call `#deletePlan(stored, false)` to delete the public entry
  while keeping the internal adapter key alive (`in-memory-edit-store.ts:230,247`).
  The caller must later call `releasePlan` to clean it up. All other deletion
  paths use the default `true`.
