package com.idebridge.jetbrains.ui

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService.Outcome.Refusal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * What the tool window has to say about each open project.
 *
 * The panel used to speak about one project — its own — and mention the others only as a list of
 * names. Every project now gets a row it can be linked or unlinked from, which turns each of the
 * panel's sentences into a per-project decision: whose row comes first, what an in-flight link
 * reads as, and when an action is worth offering at all. Those decisions are made in
 * [BridgePanelModel] so they can be stated here rather than inspected in a running IDE.
 *
 * The rule these tests exist to protect is ADR-0033's: a click that changes nothing must say why.
 */
class BridgePanelModelTest {

    private fun facts(
        name: String,
        isPanelProject: Boolean = false,
        workspaceId: String? = null,
        pending: BridgePanelModel.Pending? = null,
        refusal: Refusal? = null,
    ) = BridgePanelModel.Facts(name, isPanelProject, workspaceId, pending, refusal)

    @Test
    fun `the panel's own project comes first, the rest by name`() {
        val ordered = listOf(facts("zeta"), facts("alpha"), facts("mine", isPanelProject = true))
            .sortedWith(BridgePanelModel.ORDER)

        // Not the order the projects opened in: that reshuffles as other windows come and go, and
        // would move the row a reader is looking for.
        assertEquals(listOf("mine", "alpha", "zeta"), ordered.map { it.name })
    }

    @Test
    fun `the panel's own project is named as such, the others are not`() {
        assertEquals("mine (this project)", BridgePanelModel.row(facts("mine", isPanelProject = true), true).title)
        assertEquals("other", BridgePanelModel.row(facts("other"), true).title)
    }

    @Test
    fun `a linked project shows the workspace it serves and offers to unlink`() {
        val row = BridgePanelModel.row(facts("mine", workspaceId = "ws_abc"), daemonAvailable = true)

        assertEquals("linked as ws_abc", row.state)
        assertEquals("Unlink", row.action)
        assertTrue(row.actionEnabled)
    }

    @Test
    fun `unlinking stays available when the daemon has gone`() {
        // The link is this IDE's to release whether or not anything is still listening. Disabling
        // this row would leave a session the user can see and cannot stop.
        val row = BridgePanelModel.row(facts("mine", workspaceId = "ws_abc"), daemonAvailable = false)

        assertEquals("Unlink", row.action)
        assertTrue(row.actionEnabled)
    }

    @Test
    fun `linking is offered only when there is a daemon to link to`() {
        assertTrue(BridgePanelModel.row(facts("mine"), daemonAvailable = true).actionEnabled)
        // A button whose only outcome is failure is a worse answer than a stated reason, and the
        // daemon line above the rows is where that reason is.
        assertFalse(BridgePanelModel.row(facts("mine"), daemonAvailable = false).actionEnabled)
    }

    @Test
    fun `a refusal is stated on the row it was refused for`() {
        val refused = BridgePanelModel.row(facts("mine", refusal = Refusal.NO_CONTENT_ROOT), true)
        val untouched = BridgePanelModel.row(facts("other"), true)

        assertEquals("not linked — this project publishes no content root yet", refused.state)
        // The other rows are about other projects; one refusal must not read as everyone's.
        assertEquals("not linked", untouched.state)
    }

    @Test
    fun `every refusal reason has words, so none can reach a row as an enum name`() {
        for (reason in Refusal.entries) {
            val state = BridgePanelModel.row(facts("mine", refusal = reason), true).state
            assertTrue(state.startsWith("not linked — "), "no wording for $reason: $state")
            assertFalse(state.contains(reason.name), "$reason reached the panel unexplained")
        }
    }

    @Test
    fun `a project mid-link says so and cannot be clicked again`() {
        val linking = BridgePanelModel.row(facts("mine", pending = BridgePanelModel.Pending.LINKING), true)

        assertEquals("linking…", linking.state)
        assertEquals("Linking…", linking.action)
        // A second click would ask the service to link a project it is already linking, and the
        // only thing it could answer is `AlreadyLinked`.
        assertFalse(linking.actionEnabled)
    }

    @Test
    fun `a project mid-unlink is disabled even though it is still linked`() {
        val unlinking = BridgePanelModel.row(
            facts("mine", workspaceId = "ws_abc", pending = BridgePanelModel.Pending.UNLINKING),
            daemonAvailable = true,
        )

        assertEquals("unlinking…", unlinking.state)
        assertFalse(unlinking.actionEnabled)
    }

    @Test
    fun `the daemon line separates nothing listening from nothing linked`() {
        // Two different facts, and the panel states them in two different places: the line above
        // the rows, and each row's own state. A consumer cannot tell them apart from the outside.
        assertEquals("Daemon: reachable", BridgePanelModel.daemonLine(true))
        assertTrue(BridgePanelModel.daemonLine(false).contains("ide-bridge daemon"))
    }

    @Test
    fun `no dashboard running is stated, and names the one thing that causes it`() {
        // The section used to vanish, and the first person to notice asked whether the plugin had
        // broken — which is the question a vanished section cannot answer. It has one cause worth
        // naming: `serena` is plain Serena and publishes nothing, `junon` composes JUNON first.
        val none = BridgePanelModel.dashboardLine(0)

        assertTrue(none.contains("none running"), none)
        assertTrue(none.contains("junon"), none)
        assertEquals("JUNON dashboard", BridgePanelModel.dashboardLine(1))
        assertEquals("JUNON dashboard", BridgePanelModel.dashboardLine(4))
    }
}
