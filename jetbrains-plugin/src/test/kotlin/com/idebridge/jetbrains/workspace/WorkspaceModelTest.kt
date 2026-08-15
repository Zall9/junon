package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.protocol.AdapterId
import com.idebridge.jetbrains.protocol.WorkspaceTrust
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WorkspaceModelTest {
    private data class Snapshot(
        override val name: String = "demo",
        override val rootUris: List<String> = listOf("file:///projects/demo"),
        override val trust: WorkspaceModel.TrustState = WorkspaceModel.TrustState.GRANTED,
    ) : WorkspaceModel.ProjectSnapshot

    private fun model(): WorkspaceModel {
        var next = 0
        return WorkspaceModel("adapter_test" as AdapterId, "ws_test") { "root_${++next}" }
    }

    @Test
    fun `maps content roots with opaque identifiers and no epoch bump on first snapshot`() {
        val workspace = model().snapshot(
            Snapshot(rootUris = listOf("file:///projects/demo", "file:///projects/shared")),
        )

        assertTrue(workspace != null)
        assertEquals("ws_test", workspace.workspaceId)
        assertEquals(listOf("root_1", "root_2"), workspace.roots.map { it.rootId })
        assertEquals(listOf("demo", "shared"), workspace.roots.map { it.name })
        assertEquals(0, workspace.workspaceEpoch)
    }

    @Test
    fun `keeps a root identifier stable while its URI is unchanged`() {
        val model = model()
        val first = model.snapshot(Snapshot())!!
        val again = model.snapshot(Snapshot(name = "renamed project"))!!

        // A handle minted against this root must survive an unrelated project change.
        assertEquals(first.roots.single().rootId, again.roots.single().rootId)
        assertEquals(first.workspaceEpoch, again.workspaceEpoch)
    }

    @Test
    fun `advances the epoch only when the root set actually changes`() {
        val model = model()
        model.snapshot(Snapshot())
        val added = model.snapshot(
            Snapshot(rootUris = listOf("file:///projects/demo", "file:///projects/extra")),
        )!!
        assertEquals(1, added.workspaceEpoch)

        val unchanged = model.snapshot(
            Snapshot(rootUris = listOf("file:///projects/demo", "file:///projects/extra")),
        )!!
        assertEquals(1, unchanged.workspaceEpoch)

        val removed = model.snapshot(Snapshot(rootUris = listOf("file:///projects/demo")))!!
        assertEquals(2, removed.workspaceEpoch)
    }

    @Test
    fun `reissues an identifier for a root that was removed and came back`() {
        val model = model()
        val first = model.snapshot(Snapshot())!!
        model.snapshot(Snapshot(rootUris = listOf("file:///projects/other")))
        val returned = model.snapshot(Snapshot())!!

        // The root left the project; anything held against the old identifier is not valid again.
        assertNotEquals(first.roots.single().rootId, returned.roots.single().rootId)
    }

    @Test
    fun `reports trust as the IDE sees it, including undecided`() {
        assertEquals(
            WorkspaceTrust.UNTRUSTED,
            model().snapshot(Snapshot(trust = WorkspaceModel.TrustState.DENIED))!!.trust,
        )
        // Undecided is not "untrusted": the protocol can say so, and only "trusted" permits writes,
        // so reporting it truthfully still fails closed.
        assertEquals(
            WorkspaceTrust.UNKNOWN,
            model().snapshot(Snapshot(trust = WorkspaceModel.TrustState.UNDECIDED))!!.trust,
        )
    }

    @Test
    fun `reports no workspace for a project without content roots`() {
        assertNull(model().snapshot(Snapshot(rootUris = emptyList())))
    }

    @Test
    fun `refuses duplicate content roots`() {
        assertFailsWith<IllegalArgumentException> {
            model().snapshot(
                Snapshot(rootUris = listOf("file:///projects/demo", "file:///projects/demo")),
            )
        }
    }

    @Test
    fun `invalidating semantic state advances the epoch`() {
        val model = model()
        val before = model.snapshot(Snapshot())!!
        model.invalidateSemanticState()
        val after = model.snapshot(Snapshot())!!

        assertEquals(before.workspaceEpoch + 1, after.workspaceEpoch)
    }

    @Test
    fun `identifiers are opaque and do not leak the path`() {
        val id = WorkspaceModel.createIdentifier("ws_")
        assertTrue(id.startsWith("ws_"))
        assertTrue(id.length > 20, "identifier should carry real entropy")
        assertNotEquals(id, WorkspaceModel.createIdentifier("ws_"))
    }

    @Test
    fun `refuses a content root that is a local path rather than a URI`() {
        val model = model()

        // The daemon closes the session when an adapter returns a URI it cannot authorize, so a
        // root in the wrong shape must fail here, naming itself, rather than on the wire.
        assertFailsWith<IllegalArgumentException> {
            model.snapshot(Snapshot(rootUris = listOf("/Users/someone/project")))
        }
    }
}
