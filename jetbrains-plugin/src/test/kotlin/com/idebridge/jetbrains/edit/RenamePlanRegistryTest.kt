package com.idebridge.jetbrains.edit

import com.idebridge.jetbrains.protocol.Atomicity
import com.idebridge.jetbrains.protocol.ChangeSummary
import com.idebridge.jetbrains.protocol.EditOperation
import com.idebridge.jetbrains.protocol.EditPlan
import com.idebridge.jetbrains.protocol.Guarantee
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class RenamePlanRegistryTest {
    private var now = Instant.parse("2026-08-02T12:00:00Z")

    private val context = RenamePlanRegistry.Context(
        sessionId = "session_1",
        workspaceId = "ws_1",
        workspaceEpoch = 3,
    )

    private fun registry(maxPlans: Int = RenamePlanRegistry.DEFAULT_MAX_PLANS) =
        RenamePlanRegistry<String>(clock = { now }, maxPlans = maxPlans)

    private fun plan(id: String = "plan_1") = EditPlan(
        planId = id,
        adapterId = "adapter_1",
        sessionId = "session_1",
        workspaceId = "ws_1",
        expiresAt = "2026-08-02T12:02:00Z",
        operation = EditOperation.RENAME,
        guarantee = Guarantee.SEMANTIC,
        atomicity = Atomicity.SEMANTIC,
        preconditions = emptyList(),
        changes = listOf(ChangeSummary(uri = "file:///demo/A.java", editCount = 2)),
        warnings = emptyList(),
    )

    @Test
    fun `a registered plan is claimable once, with its payload`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        val claim = registry.claim("plan_1", context)

        val ready = assertIs<RenamePlanRegistry.Claim.Ready<String>>(claim)
        assertEquals("usages", ready.payload)
        assertEquals("plan_1", ready.plan.planId)
        assertEquals(0, registry.size)
    }

    @Test
    fun `claiming twice is refused as consumed, not as unknown`() {
        val registry = registry()
        registry.register(plan(), "usages", context)
        registry.claim("plan_1", context)

        val second = registry.claim("plan_1", context)

        // Applying twice would repeat an edit against text that already changed. Reporting it as
        // unknown would suggest the plan never existed, which is a different and wrong story.
        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.ALREADY_CONSUMED),
            second,
        )
    }

    @Test
    fun `an unknown plan is refused as unknown`() {
        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.UNKNOWN_PLAN),
            registry().claim("plan_missing", context),
        )
    }

    @Test
    fun `a plan does not survive its lifetime`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        now = now.plus(Duration.ofMinutes(5))

        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.EXPIRED),
            registry.claim("plan_1", context),
        )
    }

    @Test
    fun `a plan is bound to the session that prepared it`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.WRONG_SESSION),
            registry.claim("plan_1", context.copy(sessionId = "session_other")),
        )
        // The refusal must not consume it: the rightful session can still apply it.
        assertIs<RenamePlanRegistry.Claim.Ready<String>>(registry.claim("plan_1", context))
    }

    @Test
    fun `a plan is bound to its workspace and epoch`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.WRONG_WORKSPACE),
            registry.claim("plan_1", context.copy(workspaceId = "ws_other")),
        )
        // The epoch advances exactly when the elements the plan refers to may no longer be the
        // ones it was computed against.
        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.STALE_EPOCH),
            registry.claim("plan_1", context.copy(workspaceEpoch = 4)),
        )
    }

    @Test
    fun `discarding consumes the plan without applying it`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        assertNull(registry.discard("plan_1", context))

        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.ALREADY_CONSUMED),
            registry.claim("plan_1", context),
        )
    }

    @Test
    fun `discarding another session's plan is refused and leaves it intact`() {
        val registry = registry()
        registry.register(plan(), "usages", context)

        assertEquals(
            RenamePlanRegistry.Claim.Refusal.WRONG_SESSION,
            registry.discard("plan_1", context.copy(sessionId = "session_other")),
        )
        assertIs<RenamePlanRegistry.Claim.Ready<String>>(registry.claim("plan_1", context))
    }

    @Test
    fun `ending a session drops its plans so none survives a reconnect`() {
        val registry = registry()
        registry.register(plan("plan_1"), "a", context)
        registry.register(plan("plan_2"), "b", context.copy(sessionId = "session_2"))

        registry.forgetSession("session_1")

        assertEquals(
            RenamePlanRegistry.Claim.Refused(RenamePlanRegistry.Claim.Refusal.ALREADY_CONSUMED),
            registry.claim("plan_1", context),
        )
        assertIs<RenamePlanRegistry.Claim.Ready<String>>(
            registry.claim("plan_2", context.copy(sessionId = "session_2")),
        )
    }

    @Test
    fun `accumulated plans are bounded, oldest first`() {
        val registry = registry(maxPlans = 2)
        registry.register(plan("plan_1"), "a", context)
        registry.register(plan("plan_2"), "b", context)

        registry.register(plan("plan_3"), "c", context)

        assertEquals(2, registry.size)
        // A client preparing plans it never applies must not be able to push out a plan another
        // is about to use — but it also must not grow the registry without limit.
        assertIs<RenamePlanRegistry.Claim.Refused>(registry.claim("plan_1", context))
        assertIs<RenamePlanRegistry.Claim.Ready<String>>(registry.claim("plan_3", context))
    }
}
