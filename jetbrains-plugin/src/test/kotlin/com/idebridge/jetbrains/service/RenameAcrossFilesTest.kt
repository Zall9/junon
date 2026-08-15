package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams
import com.idebridge.jetbrains.protocol.RenameOptions
import com.idebridge.jetbrains.protocol.SymbolReference
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * A rename that crosses files, which is the ordinary kind.
 *
 * Two rules of IDEBP meet here, and the JetBrains adapter broke both while every test passed —
 * because every test renamed within one file:
 *
 * - **every document a plan changes must carry a precondition.** Otherwise applying it writes to a
 *   file whose state nobody checked. The adapter declared changes for each file and a precondition
 *   only for the declaration.
 * - **an apply must report every document the plan named.** The adapter reported one.
 *
 * The daemon refuses both, and — since they are contract violations rather than ordinary failures —
 * closes the adapter's session over them. Measured with a real IDE on 2026-08-14: preparing a rename
 * answered `PROVIDER_FAILED` and disconnected the plugin, which then reported itself connected and
 * serving until the IDE was restarted (ADR-0037 addendum; the disconnection half is
 * `ProjectLinkTest`).
 */
class RenameAcrossFilesTest : BasePlatformTestCase() {

    private lateinit var backend: AdapterBackend
    private lateinit var workspaceId: String

    private fun configure() {
        myFixture.addFileToProject(
            "Greeter.java",
            """
            public class Greeter {
                public String greet() { return "hi"; }
            }
            """.trimIndent(),
        )
        myFixture.configureByText(
            "Caller.java",
            """
            public class Caller {
                public String call() { return new Greeter().greet(); }
            }
            """.trimIndent(),
        )
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

    /** The `Greeter` class declaration, which `Caller.java` also mentions. */
    private fun greeterSymbol(): SymbolReference {
        val uri = myFixture.findFileInTempDir("Greeter.java").url
        val outcome = backend.documentSymbols(workspaceId, uri)
            ?: error("the fixture document must be describable")
        val symbols = (outcome as? AdapterRouter.SymbolsOutcome.Ready)?.result?.symbols
            ?: error("the adapter refused to describe the fixture: $outcome")
        val greeter = symbols.firstOrNull { it.locator.name == "Greeter" }
            ?: error("the fixture must declare Greeter, got ${symbols.map { it.locator.name }}")
        return SymbolReference(handle = greeter.handle, locator = greeter.locator)
    }

    private fun preparedPlan() = run {
        val outcome = backend.prepareRename(
            RefactorPrepareRenameParams(
                workspaceId = workspaceId,
                symbol = greeterSymbol(),
                newName = "Welcomer",
                options = RenameOptions(includeComments = false, includeStrings = false),
            ),
        )
        (outcome as? AdapterRouter.RenameOutcome.Prepared)?.result?.plan
            ?: error("the rename must prepare, got: $outcome")
    }

    fun `test every document the plan changes carries a precondition`() {
        configure()
        val plan = preparedPlan()

        assertTrue(
            "the fixture must produce a cross-file rename, got ${plan.changes.map { it.uri }}",
            plan.changes.size >= 2,
        )
        val guarded = plan.preconditions.map { it.uri }.toSet()
        for (change in plan.changes) {
            assertTrue(
                "no precondition guards ${change.uri}; applying it would write to text nobody checked",
                guarded.contains(change.uri),
            )
        }
        // Duplicates are refused by the daemon too, so the list must be a set of documents.
        assertEquals(guarded.size, plan.preconditions.size)
    }

    /**
     * TASK.md §30 step 12, from the adapter's side.
     *
     * `claim` checks session, workspace, epoch and expiry — and until 2026-08-14 nothing checked the
     * documents. A plan prepared against text that had since changed was **applied**: edits computed
     * for offsets that had moved were written to disk, and only then did the daemon reject the
     * response, because the reported before-hash disagreed with the plan's precondition. The refusal
     * that exists to prevent the damage arrived after it, and it closed the session too.
     *
     * The assertion is on the file, not on the code: a refusal that still wrote would be the defect.
     */
    fun `test a plan whose document changed is refused before anything is written`() {
        configure()
        val plan = preparedPlan()

        // The change the plan cannot survive, made the way a user would: through the IDE.
        val greeter = myFixture.findFileInTempDir("Greeter.java")
        val untouched = String(greeter.contentsToByteArray(), Charsets.UTF_8)
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                val document = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
                    .getDocument(greeter) ?: error("the fixture document must be loaded")
                document.insertString(0, "// changed while a plan was open\n")
                com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
                    .saveDocument(document)
            }
        }
        val changed = String(greeter.contentsToByteArray(), Charsets.UTF_8)
        assertTrue("the fixture edit must land", changed != untouched)

        val outcome = backend.applyPlan(WorkspaceApplyPlanParams(workspaceId, plan.planId))

        assertTrue(
            "a plan whose document changed must be refused, got: $outcome",
            outcome is AdapterRouter.ApplyOutcome.Refused,
        )
        assertEquals(
            "the refusal must name the condition that failed",
            com.idebridge.jetbrains.protocol.ErrorCode.PRECONDITION_FAILED,
            (outcome as AdapterRouter.ApplyOutcome.Refused).code,
        )
        assertEquals(
            "a refused plan must not have written anything",
            changed,
            String(greeter.contentsToByteArray(), Charsets.UTF_8),
        )
    }

    /**
     * The daemon holds plans of its own, and only a notification can invalidate them.
     *
     * This adapter sent no document notification at all, so after applying one plan another plan on
     * the same file was still live in the daemon's store — which forwarded it here, where the
     * precondition check refused it. Correct, but late and less useful: the daemon's own refusal
     * carries the revision to prepare against, and it can only form it if it was told (TASK.md §12).
     */
    fun `test applying announces every document it changed`() {
        configure()
        val plan = preparedPlan()
        val announced = mutableListOf<String>()
        backend.announceChange = { content -> announced.add(content.document.uri) }

        backend.applyPlan(WorkspaceApplyPlanParams(workspaceId, plan.planId))

        assertEquals(
            "every changed document must be announced, or the daemon cannot invalidate what it holds",
            plan.changes.map { it.uri }.toSet(),
            announced.toSet(),
        )
    }

    // An edit made on disk, outside the IDE, is guarded by `refreshUnmodifiedFromDisk` and is
    // deliberately **not** tested here: `BasePlatformTestCase` runs on an in-memory file system, so
    // there is no disk to write behind the IDE's back and a test written against it would prove
    // nothing while looking like proof. That rule is verified against a real IDE instead, and the
    // measurement is recorded in DEMO.md.

    fun `test applying reports every document the plan named`() {
        configure()
        val plan = preparedPlan()
        val planned = plan.changes.map { it.uri }.toSet()

        val outcome = backend.applyPlan(WorkspaceApplyPlanParams(workspaceId, plan.planId))
        val applied = (outcome as? AdapterRouter.ApplyOutcome.Applied)?.result
            ?: error("the plan must apply, got: $outcome")

        assertEquals(
            "the result must account for every document the plan named",
            planned,
            applied.modifiedDocuments.map { it.document.uri }.toSet(),
        )
        for (document in applied.modifiedDocuments) {
            assertTrue(
                "a document reported as modified must actually have changed: ${document.document.uri}",
                document.beforeHash != document.afterHash,
            )
            assertEquals(
                "the revision hash must agree with the reported after-hash",
                document.document.revision.contentHash,
                document.afterHash,
            )
        }
    }
}
