package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.protocol.EditOperation
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.RefactorPrepareParams
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * A quick fix through the two-phase machinery, against a real project.
 *
 * The two guarantees that matter here are the ones an approximate implementation would lose:
 * **preparing must not change the file** — otherwise a consumer reviewing a plan is reviewing an
 * edit that already happened — and **applying must refuse an offer that no longer exists**, rather
 * than running whatever fix now occupies that position.
 */
class QuickFixPlanTest : BasePlatformTestCase() {

    private lateinit var backend: AdapterBackend

    private fun configure(source: String) {
        myFixture.configureByText("Service.java", source)
        myFixture.doHighlighting()
        val tracker = DaemonAnalysisTracker(project).also { it.start() }
        Disposer.register(testRootDisposable, tracker)
        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")
        workspaceId = workspace.workspaceId
        backend = AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = "session_test",
            workspaceEpoch = model.currentEpoch,
            tracker = tracker,
        )
    }

    private lateinit var workspaceId: String

    private fun offeredFix(): Pair<String, String> {
        val uri = myFixture.file.virtualFile.url
        val outcome = backend.diagnostics(workspaceId, listOf(uri))
            ?: error("diagnostics must be available")
        val snapshot = (outcome as? AdapterRouter.DiagnosticsOutcome.Ready)?.result
            ?: error("the fixture project must be analysable, but the adapter refused: $outcome")
        val fix = snapshot.documents
            .flatMap { it.diagnostics }
            .firstNotNullOfOrNull { it.availableFixes?.firstOrNull() }
            ?: error("the fixture must offer at least one quick fix")
        return uri to fix.fixId
    }

    private fun prepare(uri: String, fixId: String) =
        backend.prepare(
            RefactorPrepareParams(
                workspaceId = workspaceId,
                operation = EditOperation.QUICK_FIX,
                uri = uri,
                arguments = mapOf("fixId" to fixId),
            ),
        )

    fun `test preparing a quick fix leaves the file untouched`() {
        configureWithWorkspace()
        val before = myFixture.file.text
        val (uri, fixId) = offeredFix()

        val outcome = prepare(uri, fixId)

        assertTrue("preparing must succeed", outcome is AdapterRouter.RenameOutcome.Prepared)
        // The whole point of two phases: a consumer reviews a plan, not a completed edit.
        assertEquals(before, myFixture.file.text)
    }

    fun `test applying a quick fix changes the file`() {
        configureWithWorkspace()
        val before = myFixture.file.text
        val (uri, fixId) = offeredFix()
        val prepared = prepare(uri, fixId) as AdapterRouter.RenameOutcome.Prepared

        val applied = backend.applyPlan(
            WorkspaceApplyPlanParams(workspaceId, prepared.result.plan.planId),
        )

        assertTrue("applying must succeed", applied is AdapterRouter.ApplyOutcome.Applied)
        assertFalse("the fix must have changed the file", before == myFixture.file.text)
    }

    fun `test an id this adapter never offered is refused`() {
        configureWithWorkspace()
        val uri = myFixture.file.virtualFile.url

        val outcome = prepare(uri, "0".repeat(32))

        assertEquals(
            AdapterRouter.RenameOutcome.Refused(ErrorCode.PRECONDITION_FAILED),
            outcome,
        )
    }

    private fun configureWithWorkspace() {
        configure(
            """
            class Service {
                private int count = "not an int";
            }
            """.trimIndent(),
        )
    }
}
