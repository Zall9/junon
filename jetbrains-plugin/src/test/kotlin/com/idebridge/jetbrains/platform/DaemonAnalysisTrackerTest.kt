package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The completeness signal, against the real daemon.
 *
 * This closes the gap the end-to-end run exposed: `getHighlights` returns what has already been
 * computed, so a document nobody analysed answers empty, and empty reads as clean. Only a real
 * daemon can show whether the tracker actually observes analysis finishing.
 */
class DaemonAnalysisTrackerTest : BasePlatformTestCase() {

    private lateinit var tracker: DaemonAnalysisTracker

    override fun setUp() {
        super.setUp()
        tracker = DaemonAnalysisTracker(project)
        tracker.start()
        Disposer.register(testRootDisposable, tracker)
    }

    private fun configure() = myFixture.configureByText(
        "Service.java",
        """
        class Service {
            private int count = "not an int";
        }
        """.trimIndent(),
    )

    fun `test a document is pending until the daemon has finished it`() {
        val file = configure()
        val document = myFixture.getDocument(file)

        // Nothing has run yet, so the empty highlight set proves nothing about the file.
        assertEquals(DiagnosticMapping.Analysis.PENDING, tracker.state(file, document))

        myFixture.doHighlighting()

        assertEquals(DiagnosticMapping.Analysis.COMPLETED, tracker.state(file, document))
    }

    fun `test a pending document reports its snapshot as incomplete`() {
        val file = configure()
        val document = myFixture.getDocument(file)

        val before = DiagnosticMapping.map(
            IntelliJDiagnostics.highlights(project, document),
            com.idebridge.jetbrains.document.LineIndex(document.charsSequence),
            tracker.state(file, document),
        )

        // The defect this exists to prevent: no diagnostics, but the file is not clean.
        assertTrue(before.diagnostics.isEmpty())
        assertTrue("an unanalysed document must not look clean", before.truncated)

        myFixture.doHighlighting()

        val after = DiagnosticMapping.map(
            IntelliJDiagnostics.highlights(project, document),
            com.idebridge.jetbrains.document.LineIndex(document.charsSequence),
            tracker.state(file, document),
        )
        assertFalse("once analysed, the answer is complete", after.truncated)
        assertFalse("and it carries the real error", after.diagnostics.isEmpty())
    }

    fun `test invalidating a document makes the next answer incomplete again`() {
        val file = configure()
        val document = myFixture.getDocument(file)
        myFixture.doHighlighting()
        assertEquals(DiagnosticMapping.Analysis.COMPLETED, tracker.state(file, document))

        // An edit invalidates what the daemon knew; the answer must go back to incomplete rather
        // than keep asserting a result computed against text that has changed.
        tracker.invalidate(file.virtualFile.url)

        assertEquals(DiagnosticMapping.Analysis.PENDING, tracker.state(file, document))
    }
}
