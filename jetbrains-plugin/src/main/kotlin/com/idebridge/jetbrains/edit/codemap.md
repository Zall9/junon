# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/edit/

## Responsibility

Schedules edit operations on the IntelliJ dispatch thread inside write commands, and holds prepared edit plans between the two-phase `prepare` → `apply` lifecycle. Two files: `EditScheduler` (the threading abstraction, platform-free) and `RenamePlanRegistry` (plan bookkeeping, generic over the payload). Both are free of platform types — the implementation that touches the EDT lives in `platform/IntelliJEditScheduler`, and the registry stores whatever payload the adapter needs.

## Design Patterns

- **Threading abstraction (dependency inversion)** — `EditScheduler` is an interface with a single `runWrite` method. The routing and plan bookkeeping stay testable without an IDE; only `IntelliJEditScheduler` (platform/) knows about `WriteCommandAction` and `invokeAndWait` (EditScheduler.kt:14-22).
- **Consume-once plans (ADR-0021)** — A plan is claimed once. Applying the same plan twice would repeat an edit against text that has already changed. A consumed plan is remembered as consumed (not forgotten), so the second attempt is refused for the true reason (`ALREADY_CONSUMED`) instead of looking like a plan that never existed (`UNKNOWN_PLAN`) (RenamePlanRegistry.kt:20-23, 88-94).
- **Generic over payload** — `RenamePlanRegistry<P>` stores whatever the adapter needs to perform the refactoring. The JetBrains adapter stores `IntelliJRename.Prepared`, document operations, or quick-fix ids — the registry does not know or care (RenamePlanRegistry.kt:16-17, 24).
- **Session/workspace/epoch binding** — Every claim checks `sessionId`, `workspaceId`, and `workspaceEpoch`. A plan from another session, another workspace, or a stale epoch is refused before checking expiry — a plan from another session is not this caller's to be told anything about beyond refusal (RenamePlanRegistry.kt:96-108).
- **Bounded plan store** — `maxPlans` (default 32) with FIFO eviction: a client that prepares plans and never applies them must not push out a plan another client is about to use (RenamePlanRegistry.kt:70-75). `consumed` set is also bounded at 256 entries (RenamePlanRegistry.kt:142-145, 156).
- **Expiry before identity, identity before expiry** — Identity checks (session, workspace, epoch) come before the expiry check, because reporting a plan from another session as "merely expired" would be misleading (RenamePlanRegistry.kt:96-113).

## Key Types

- `EditScheduler` (interface, `EditScheduler.kt:14`) — Runs a mutation where the IDE allows one. Implementations must run the block to completion before returning: an edit still in flight when the response is sent would report a modification the consumer cannot yet observe.
  - `Direct` (companion, `:19-21`) — Inline implementation for tests and callers already holding the right context. Using it in production would run a write action on a background thread, which the platform forbids.
- `RenamePlanRegistry<P>` (class, `RenamePlanRegistry.kt:24-28`) — Thread-safe (single `ReentrantLock`, `:59`) store for prepared edit plans. Generic over the payload `P`.
  - `Context` (data, `:29-33`) — `sessionId: SessionId`, `workspaceId: WorkspaceId`, `workspaceEpoch: Int`. Checked on every claim and discard.
  - `Claim<P>` (sealed interface, `:35-48`) — `Ready<P>(plan: EditPlan, payload: P)` | `Refused(reason: Refusal)`.
  - `Refusal` (enum, `:38-45`) — `UNKNOWN_PLAN`, `ALREADY_CONSUMED`, `EXPIRED`, `WRONG_SESSION`, `WRONG_WORKSPACE`, `STALE_EPOCH`.
  - `Entry<P>` (private, `:50-57`) — Stored per plan id: `plan`, `payload`, `sessionId`, `workspaceId`, `workspaceEpoch`, `expiresAt`.
  - Constants: `DEFAULT_TIME_TO_LIVE = Duration.ofMinutes(2)` (`:148`), `DEFAULT_MAX_PLANS = 32` (`:149`), `MAX_REMEMBERED_CONSUMED = 256` (`:156`).

## Key Functions

- `EditScheduler.runWrite(block: () -> T): T` (`EditScheduler.kt:15`) — Runs `block` to completion. The production implementation (`IntelliJEditScheduler`) wraps it in `WriteCommandAction` on the dispatch thread via `invokeAndWait`.
- `RenamePlanRegistry.register(plan: EditPlan, payload: P, context: Context): Instant` (`RenamePlanRegistry.kt:68-85`) — Stores a plan with its payload and context, computing `expiresAt = clock() + timeToLive`. Evicts oldest plans (FIFO) when `entries.size >= maxPlans`. Returns the expiry instant.
- `RenamePlanRegistry.claim(planId: PlanId, context: Context): Claim<P>` (`:88-118`) — Claims a plan for application. Success consumes it (moves to `consumed`, removes from `entries`). Every refusal leaves the entry untouched — except `EXPIRED`, which also removes and consumes the entry (an expired plan is gone either way). Checks identity (session, workspace, epoch) before expiry.
- `RenamePlanRegistry.discard(planId: PlanId, context: Context): Claim.Refusal?` (`:121-129`) — Drops a plan without applying. Returns `null` on success, or a `Refusal` for the same reasons a claim would refuse (except `EXPIRED` is not checked — discarding an expired plan succeeds).
- `RenamePlanRegistry.forgetSession(sessionId: SessionId)` (`:132-138`) — Drops every plan for a session. Called when it ends, so nothing survives a reconnect. Consumed plans are also marked consumed.
- `consume(planId)` (`:140-145`, private) — Adds to `consumed` set, evicting oldest when > `MAX_REMEMBERED_CONSUMED`. Beyond the bound, a repeat is reported as `UNKNOWN_PLAN` — weaker but never wrong.

## Data & Control Flow

```
prepare phase:
  AdapterBackend.prepare() / prepareRename()
    │  plans.register(EditPlan, PreparedEdit payload, Context)
    │    ├─ expiresAt = clock() + 2 minutes
    │    ├─ evict oldest if entries.size >= 32
    │    └─ entries[planId] = Entry(plan, payload, context, expiresAt)
    ▼
  EditPlan returned to consumer (with planId, expiresAt, preconditions)

apply phase:
  AdapterBackend.applyPlan()
    │  plans.claim(planId, Context)
    │    ├─ wrong session?   ──► Refused(WRONG_SESSION)
    │    ├─ wrong workspace? ──► Refused(WRONG_WORKSPACE)
    │    ├─ stale epoch?     ──► Refused(STALE_EPOCH)
    │    ├─ expired?         ──► remove, consume, Refused(EXPIRED)
    │    ├─ not found?       ──► in consumed? Refused(ALREADY_CONSUMED) : Refused(UNKNOWN_PLAN)
    │    └─ found            ──► remove, consume, Ready(plan, payload)
    ▼
  scheduler.runWrite { apply payload }  ──► ModificationResult

discard:
  AdapterBackend.discardPlan()
    │  plans.discard(planId, Context)
    │    ├─ found ──► remove, consume, null (success)
    │    └─ not found ──► Refusal (same as claim, minus EXPIRED)
```

## Integration Points

- **Consumed by**: `com.idebridge.jetbrains.service.AdapterBackend` — holds a `RenamePlanRegistry<PreparedEdit>` instance and calls `register`, `claim`, `discard` during prepare/apply/discard (AdapterBackend.kt:118, 351, 549, 600, 607, 755).
- **Depends on**: `com.idebridge.jetbrains.protocol` — `EditPlan`, `PlanId`, `SessionId`, `WorkspaceId`. JDK concurrency (`java.util.concurrent.locks.ReentrantLock`, `kotlin.concurrent.withLock`). `java.time` (`Instant`, `Duration`).
- **External boundaries**: `EditScheduler` is implemented by `IntelliJEditScheduler` (platform/) which wraps `WriteCommandAction.writeCommandAction(project).compute`. The registry's `clock` default is `Instant::now`, injectable for tests.

## Common Gotchas

- **A consumed plan is remembered, not forgotten** — A second apply of the same plan gets `ALREADY_CONSUMED`, not `UNKNOWN_PLAN`. This is the true reason, and the caller can act on it (RenamePlanRegistry.kt:20-23, 90-94).
- **`MAX_REMEMBERED_CONSUMED` is a soft bound** — Beyond 256 consumed ids, a repeat is reported as `UNKNOWN_PLAN`. Weaker than `ALREADY_CONSUMED`, but never wrong — the plan is gone either way (RenamePlanRegistry.kt:151-156).
- **Identity checks before expiry** — A plan from another session reported as "expired" would be misleading. Session, workspace, and epoch are checked first; only then is expiry assessed (RenamePlanRegistry.kt:96-113).
- **`discard` does not check expiry** — Discarding an expired plan succeeds; there is no reason to refuse a disposal the caller is already performing (RenamePlanRegistry.kt:121-129).
- **`claim` on an expired plan consumes it** — An expired plan is removed and marked consumed, so a later claim gets `ALREADY_CONSUMED`, not `EXPIRED` again (RenamePlanRegistry.kt:109-113).
- **`register` evicts oldest first** — FIFO, not LRU. A client that prepares plans and never applies them cannot starve others by unbounded accumulation (RenamePlanRegistry.kt:70-75).
- **`runWrite` must complete before returning** — An edit still in flight when the response is sent would report a modification the consumer cannot yet observe (EditScheduler.kt:11-13). `IntelliJEditScheduler` uses `invokeAndWait` to guarantee this.
- **`Direct` is for tests only** — Using `EditScheduler.Direct` in production would run a write action on a background thread, which the platform forbids (EditScheduler.kt:19-21).
