package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * A project the index cannot answer for, and what the adapter says about it.
 *
 * This is the state that cost an hour of a real session to identify (ADR-0034): files sitting in a
 * content root that no module marks as **sources**, so the index is complete and holds nothing for
 * them. The IDE's own Go-to-Symbol finds nothing there either — the adapter is agreeing with the IDE,
 * not failing — and an unflagged empty list is indistinguishable from "no such symbol".
 *
 * The fixture has a source root by construction, so the state has to be built by taking it away. That
 * is the whole reason this state had no test: nothing in a normal fixture reaches it.
 */
class UnindexedProjectTest : BasePlatformTestCase() {

    /**
     * Source roots taken away for a test, to be given back in [tearDown].
     *
     * The light fixture **shares one project across tests**, so a root removed here stays removed for
     * everything that runs after it in the same JVM — which is exactly what happened the first time
     * this file ran: the control test below saw no source root and failed, and any other class asking
     * about roots would have been next. Borrowing from a shared fixture means returning it.
     */
    private val borrowed = mutableListOf<VirtualFile>()

    private fun removeSourceRoots() {
        for (root in ProjectRootManager.getInstance(project).contentSourceRoots) {
            borrowed.add(root)
            PsiTestUtil.removeSourceRoot(module, root)
        }
    }

    override fun tearDown() {
        try {
            for (root in borrowed) PsiTestUtil.addSourceRoot(module, root)
            borrowed.clear()
        } finally {
            super.tearDown()
        }
    }

    fun `test the fixture has a source root, which is what makes the other case a removal`() {
        assertTrue(
            "if this fails the fixture changed, and the test below stops meaning anything",
            IntelliJProjectSnapshot.hasSourceRoots(project),
        )
    }

    fun `test a project with no source root is reported as such`() {
        removeSourceRoots()

        assertFalse(
            "a content root that no module marks as sources leaves the index nothing to hold",
            IntelliJProjectSnapshot.hasSourceRoots(project),
        )
    }

    fun `test a search over an unindexed project answers, and says it is incomplete`() {
        myFixture.configureByText("Service.kt", "class Service {\n    fun run() {}\n}")
        removeSourceRoots()

        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")
        val backend = AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = "session_unindexed_test",
            workspaceEpoch = model.currentEpoch,
            tracker = DaemonAnalysisTracker(project),
        )

        val outcome = backend.searchSymbols(
            WorkspaceSearchSymbolsParams(workspace.workspaceId, "Service", limit = 50),
        )

        // Answered, not refused: retrying will never help, so `INDEX_NOT_READY` would promise
        // something untrue. The flag is what carries the incompleteness instead.
        val found = outcome as? AdapterRouter.SearchOutcome.Found
            ?: error("an unindexed project must be answered, not refused, got: $outcome")
        assertTrue(
            "the workspace holds matches this response cannot carry, which is what the flag means",
            found.result.truncated,
        )
    }

    fun `test diagnostics over an unindexed project are refused, not answered empty`() {
        myFixture.configureByText("Service.kt", "class Service {\n    fun run() {}\n}")
        val uri = myFixture.file.virtualFile.url
        removeSourceRoots()

        val outcome = backendFor().diagnostics(workspaceIdOf(), listOf(uri))

        // The opposite choice to search, and for a reason that only shows up in use. The same
        // `truncated` flag on this route also means "analysis has not finished", so a consumer
        // polling until it clears is behaving correctly — and against a project that can never be
        // analysed it polls for ever. Measured on a real IntelliJ before this refusal existed:
        // eight requests over thirty-two seconds, each zero diagnostics with truncated = true.
        assertEquals(
            "an unanalysable project must be refused, so a caller stops waiting",
            AdapterRouter.DiagnosticsOutcome.NotAnalysable,
            outcome,
        )
    }

    fun `test diagnostics are answered normally when the project has its source roots`() {
        // The control. Without it the test above passes just as well against a route that refuses
        // everything.
        myFixture.configureByText("Service.kt", "class Service {\n    fun run() {}\n}")
        val uri = myFixture.file.virtualFile.url

        val outcome = backendFor().diagnostics(workspaceIdOf(), listOf(uri))

        assertTrue(
            "a normal project must produce a snapshot, got: $outcome",
            outcome is AdapterRouter.DiagnosticsOutcome.Ready,
        )
    }

    private lateinit var lastWorkspaceId: String

    private fun backendFor(): AdapterBackend {
        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")
        lastWorkspaceId = workspace.workspaceId
        return AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = "session_unindexed_test",
            workspaceEpoch = model.currentEpoch,
            tracker = DaemonAnalysisTracker(project),
        )
    }

    private fun workspaceIdOf(): String = lastWorkspaceId

    fun `test the warning can be switched off, and back on`() {
        val was = IndexHealthNotifier.isEnabled()
        try {
            IndexHealthNotifier.setEnabled(false)
            assertFalse(IndexHealthNotifier.isEnabled())
            // Disabled means silent, not broken: the route still calls this on every search.
            IndexHealthNotifier.warnNoSourceRoots(project)

            IndexHealthNotifier.setEnabled(true)
            assertTrue(IndexHealthNotifier.isEnabled())
        } finally {
            IndexHealthNotifier.setEnabled(was)
        }
    }
}
