package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The fact the incomplete-snapshot note rests on: a file nobody opened is still analysed.
 *
 * `DaemonCodeAnalyzer` finishes *editors* — `daemonFinished` is handed file editors, and a file no
 * editor holds is never among them. Read alone, that says a closed file will never be analysed, and
 * a tool built on that reading tells its caller to go and open the file. Twice now that reading has
 * looked right; the adapter opens the file itself before asking, so the caller only ever had to wait.
 *
 * Pinned here because the two halves live far apart: the opening is in [AdapterBackend], the advice
 * is in the Python tool, and nothing between them would have noticed the day one stopped matching
 * the other.
 */
class DiagnosticsOnDemandTest : BasePlatformTestCase() {

    /** Closed again in [tearDown]: the light fixture shares one project across every test in the JVM. */
    private var opened: VirtualFile? = null

    override fun tearDown() {
        try {
            opened?.let { FileEditorManager.getInstance(project).closeFile(it) }
            opened = null
        } finally {
            super.tearDown()
        }
    }

    fun `test asking about a file no editor holds opens it, so waiting is the right advice`() {
        val file = myFixture.addFileToProject("Cold.java", "class Cold {\n    void run() {}\n}")
        val virtualFile = file.virtualFile
        val editors = FileEditorManager.getInstance(project)
        assertFalse(
            "the file has to start closed, or this test proves nothing",
            editors.isFileOpen(virtualFile),
        )
        opened = virtualFile

        val outcome = backend().diagnostics(workspaceId, listOf(virtualFile.url))

        assertTrue(
            "a closed file must still produce a snapshot, got: $outcome",
            outcome is AdapterRouter.DiagnosticsOutcome.Ready,
        )
        assertTrue(
            "the adapter opens the file it was asked about — which is why the tool tells its caller " +
                "to ask again rather than to open anything",
            editors.isFileOpen(virtualFile),
        )
    }

    private lateinit var workspaceId: String

    private fun backend(): AdapterBackend {
        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")
        workspaceId = workspace.workspaceId
        return AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = "session_on_demand_test",
            workspaceEpoch = model.currentEpoch,
            tracker = DaemonAnalysisTracker(project),
        )
    }
}
