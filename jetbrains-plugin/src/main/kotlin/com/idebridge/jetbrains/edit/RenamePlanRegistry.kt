package com.idebridge.jetbrains.edit

import com.idebridge.jetbrains.protocol.EditPlan
import com.idebridge.jetbrains.protocol.PlanId
import com.idebridge.jetbrains.protocol.SessionId
import com.idebridge.jetbrains.protocol.WorkspaceId
import java.time.Duration
import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Holds prepared edit plans between `refactor/prepareRename` and `workspace/applyPlan`.
 *
 * Generic over the payload so the bookkeeping is testable without the platform; the adapter stores
 * whatever it needs to perform the refactoring — the refactoring object and its usages.
 *
 * A plan is **consumed once**. Applying the same plan twice would repeat an edit against text that
 * has already changed, and the second application would be against a document the plan's
 * preconditions no longer describe. A consumed plan is remembered as consumed rather than simply
 * forgotten, so the second attempt is refused for the true reason instead of looking like a plan
 * that never existed (ADR-0021).
 */
public class RenamePlanRegistry<P>(
    private val clock: () -> Instant = Instant::now,
    private val timeToLive: Duration = DEFAULT_TIME_TO_LIVE,
    private val maxPlans: Int = DEFAULT_MAX_PLANS,
) {
    public data class Context(
        val sessionId: SessionId,
        val workspaceId: WorkspaceId,
        val workspaceEpoch: Int,
    )

    public sealed interface Claim<out P> {
        public data class Ready<P>(val plan: EditPlan, val payload: P) : Claim<P>

        public enum class Refusal {
            UNKNOWN_PLAN,
            ALREADY_CONSUMED,
            EXPIRED,
            WRONG_SESSION,
            WRONG_WORKSPACE,
            STALE_EPOCH,
        }

        public data class Refused(val reason: Refusal) : Claim<Nothing>
    }

    private class Entry<P>(
        val plan: EditPlan,
        val payload: P,
        val sessionId: SessionId,
        val workspaceId: WorkspaceId,
        val workspaceEpoch: Int,
        val expiresAt: Instant,
    )

    private val lock = ReentrantLock()
    private val entries = linkedMapOf<PlanId, Entry<P>>()

    /** Plan ids already applied or discarded, kept so a repeat is refused truthfully. */
    private val consumed = linkedSetOf<PlanId>()

    public val size: Int
        get() = lock.withLock { entries.size }

    public fun register(plan: EditPlan, payload: P, context: Context): Instant = lock.withLock {
        val expiresAt = clock().plus(timeToLive)
        // Oldest first: a client that prepares plans and never applies them must not be able to
        // push out a plan another client is about to use by unbounded accumulation.
        while (entries.size >= maxPlans) {
            val oldest = entries.keys.firstOrNull() ?: break
            entries.remove(oldest)
        }
        entries[plan.planId] = Entry(
            plan = plan,
            payload = payload,
            sessionId = context.sessionId,
            workspaceId = context.workspaceId,
            workspaceEpoch = context.workspaceEpoch,
            expiresAt = expiresAt,
        )
        expiresAt
    }

    /** Claims a plan for application. Success consumes it; every refusal leaves it untouched. */
    public fun claim(planId: PlanId, context: Context): Claim<P> = lock.withLock {
        val entry = entries[planId]
            ?: return if (planId in consumed) {
                Claim.Refused(Claim.Refusal.ALREADY_CONSUMED)
            } else {
                Claim.Refused(Claim.Refusal.UNKNOWN_PLAN)
            }

        // Checked before expiry: a plan from another session is not this caller's to be told
        // anything about beyond refusal, and reporting it as merely expired would be misleading.
        if (entry.sessionId != context.sessionId) {
            return Claim.Refused(Claim.Refusal.WRONG_SESSION)
        }
        if (entry.workspaceId != context.workspaceId) {
            return Claim.Refused(Claim.Refusal.WRONG_WORKSPACE)
        }
        // The epoch advances when the workspace's semantic state is invalidated, which is exactly
        // when the elements this plan refers to may no longer be the ones it was computed against.
        if (entry.workspaceEpoch != context.workspaceEpoch) {
            return Claim.Refused(Claim.Refusal.STALE_EPOCH)
        }
        if (!clock().isBefore(entry.expiresAt)) {
            entries.remove(planId)
            consume(planId)
            return Claim.Refused(Claim.Refusal.EXPIRED)
        }

        entries.remove(planId)
        consume(planId)
        Claim.Ready(entry.plan, entry.payload)
    }

    /** Drops a plan without applying it. Refuses for the same reasons a claim would. */
    public fun discard(planId: PlanId, context: Context): Claim.Refusal? = lock.withLock {
        val entry = entries[planId]
            ?: return if (planId in consumed) Claim.Refusal.ALREADY_CONSUMED else Claim.Refusal.UNKNOWN_PLAN
        if (entry.sessionId != context.sessionId) return Claim.Refusal.WRONG_SESSION
        if (entry.workspaceId != context.workspaceId) return Claim.Refusal.WRONG_WORKSPACE
        entries.remove(planId)
        consume(planId)
        null
    }

    /** Drops every plan for a session — called when it ends, so nothing survives a reconnect. */
    public fun forgetSession(sessionId: SessionId): Unit = lock.withLock {
        val stale = entries.filterValues { it.sessionId == sessionId }.keys.toList()
        stale.forEach {
            entries.remove(it)
            consume(it)
        }
    }

    private fun consume(planId: PlanId) {
        consumed.add(planId)
        while (consumed.size > MAX_REMEMBERED_CONSUMED) {
            consumed.remove(consumed.first())
        }
    }

    public companion object {
        public val DEFAULT_TIME_TO_LIVE: Duration = Duration.ofMinutes(2)
        public const val DEFAULT_MAX_PLANS: Int = 32

        /**
         * How many consumed ids are remembered. Bounded because it grows without limit otherwise;
         * beyond it a repeat is reported as unknown, which is a weaker answer but never a wrong
         * one — the plan is gone either way.
         */
        public const val MAX_REMEMBERED_CONSUMED: Int = 256
    }
}
