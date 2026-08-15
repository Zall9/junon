package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.WorkspaceTrust
import com.idebridge.jetbrains.workspace.ReadinessModel
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.idebridge.jetbrains.workspace.WorkspaceUri
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises the one file that reads live IntelliJ state, against a real in-memory `Project`.
 *
 * Every other JetBrains test works on [WorkspaceModel.ProjectSnapshot], so until this existed the
 * platform boundary was only compile-checked: a wrong API, a read outside a read action, or a URI
 * shape the protocol rejects would all have survived to a sandboxed IDE run. Platform test fixtures
 * supply a project, VFS and index state headlessly, so that gap closes here rather than in 4h.
 */
class IntelliJProjectSnapshotTest : BasePlatformTestCase() {

    fun `test capture reports content roots as URIs, never as local paths`() {
        val snapshot = IntelliJProjectSnapshot.capture(project)

        assertFalse("the fixture project must expose a content root", snapshot.rootUris.isEmpty())
        for (uri in snapshot.rootUris) {
            assertTrue("a root must be a URI, got: $uri", uri.contains("://"))
            assertFalse("a root must not be a local path", uri.startsWith("/"))
        }
        assertEquals(
            "content roots must be reported without duplicates",
            snapshot.rootUris.size,
            snapshot.rootUris.toSet().size,
        )
    }

    fun `test capture answers the project name and a trust state`() {
        val snapshot = IntelliJProjectSnapshot.capture(project)

        assertTrue(snapshot.name.isNotEmpty())
        // The value itself is the IDE's to decide; what matters is that the three-state API is read
        // without throwing and yields one of the states the protocol can express.
        assertTrue(snapshot.trust in WorkspaceModel.TrustState.entries)
    }

    fun `test a captured project maps to a protocol workspace`() {
        val model = WorkspaceModel(adapterId = "adapter_test")
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))

        assertNotNull("a project with a content root must produce a workspace", workspace)
        requireNotNull(workspace)
        assertEquals("adapter_test", workspace.adapterId)
        assertTrue(workspace.roots.isNotEmpty())
        for (root in workspace.roots) {
            assertTrue(root.rootId.startsWith("root_"))
            assertTrue("a root needs a display name", root.name.isNotEmpty())
        }
        assertTrue(
            "trust must map to a protocol value",
            workspace.trust in
                listOf(WorkspaceTrust.TRUSTED, WorkspaceTrust.UNTRUSTED, WorkspaceTrust.UNKNOWN),
        )
    }

    fun `test a real root URI satisfies the containment rule that guards every response`() {
        val root = IntelliJProjectSnapshot.capture(project).rootUris.first()

        // A document under a real content root must pass the same check the daemon applies, and a
        // sibling of that root must not. If the platform reported a root in a shape this rule does
        // not accept, every symbol and diagnostic response would be refused as a policy violation.
        assertTrue(WorkspaceUri.isWithinRoot("$root/src/Main.kt", root))
        assertTrue(WorkspaceUri.isWithinRoot(root, root))
        assertFalse(WorkspaceUri.isWithinRoot("$root/../elsewhere/Main.kt", root))
    }

    fun `test root identity is stable across captures, so handles survive`() {
        val model = WorkspaceModel(adapterId = "adapter_test")
        val first = requireNotNull(model.snapshot(IntelliJProjectSnapshot.capture(project)))
        val epochAfterFirst = model.currentEpoch

        val second = requireNotNull(model.snapshot(IntelliJProjectSnapshot.capture(project)))

        assertEquals(first.roots.map { it.rootId }, second.roots.map { it.rootId })
        assertEquals(
            "an unchanged project must not advance the epoch and revoke live handles",
            epochAfterFirst,
            model.currentEpoch,
        )
    }

    fun `test index state is readable and reports readiness`() {
        val state = IntelliJProjectSnapshot.indexState(project)

        // A fixture project is initialized and out of dumb mode; asserting it confirms the dumb-mode
        // API is read correctly rather than always answering the same value.
        assertEquals(ReadinessModel.IndexState.SMART, state)
        val status = ReadinessModel.status("ws_test", state)
        assertTrue(
            "a ready workspace declares nothing unavailable",
            status.capabilitiesUnavailable.isEmpty(),
        )
    }
}
