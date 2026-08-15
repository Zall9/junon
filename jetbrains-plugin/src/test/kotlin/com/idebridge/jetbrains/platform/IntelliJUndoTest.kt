package com.idebridge.jetbrains.platform

import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises undo against the IDE's real undo stack.
 *
 * What only a real project can answer is whether reverting leaves the platform in a state a caller
 * can read. It does not, by default: undo reverts the *document*, and PSI catches up only when
 * committed. An adapter that read `PsiFile.text` straight after a successful undo got the pre-undo
 * text, reported a document whose before- and after-hashes matched, and had the whole response
 * refused by the daemon — correctly, since that is indistinguishable from claiming a modification
 * that never happened.
 *
 * These tests exist so that returns rather than being rediscovered from a close frame.
 */
class IntelliJUndoTest : BasePlatformTestCase() {

    private fun configure(): PsiJavaFile =
        myFixture.configureByText(
            "Service.java",
            """
            class Service {
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        ) as PsiJavaFile

    private fun method(file: PsiJavaFile) = file.classes.single().methods.single()

    fun `test reverting a rename restores the text PSI reports`() {
        val file = configure()
        val original = file.text

        val prepared = IntelliJRename.prepare(project, method(file), "amount")
        assertInstanceOf(prepared, IntelliJRename.Outcome.Ready::class.java)
        IntelliJRename.apply((prepared as IntelliJRename.Outcome.Ready).prepared)
        assertFalse("renaming should have changed the file", file.text == original)

        val outcome = IntelliJUndo.undo(project, file.virtualFile)

        assertEquals(IntelliJUndo.Outcome.Reverted, outcome)
        // The assertion that matters: read through PSI, the way the adapter does. Without the
        // commit inside `undo` this still holds the renamed text and the revert looks like a no-op.
        assertEquals(original, file.text)
    }

    fun `test a reverted document is not reported as unchanged`() {
        val file = configure()

        val prepared = IntelliJRename.prepare(project, method(file), "amount")
        IntelliJRename.apply((prepared as IntelliJRename.Outcome.Ready).prepared)
        val afterRename = file.text

        IntelliJUndo.undo(project, file.virtualFile)

        // The daemon refuses a modified document whose before- and after-hashes are equal. This is
        // that check, stated where the adapter can fail it.
        assertFalse(
            "an undo that reports identical hashes is refused as a phantom modification",
            afterRename == file.text,
        )
    }

    // `NothingToUndo` is deliberately not covered here. A fixture that configures a file has already
    // put an undoable entry on the stack, so a fresh document reports `Reverted` — the case is not
    // reachable in this harness, and asserting it would be measuring the fixture rather than the
    // adapter. Reaching it needs a document the IDE has never edited.
}
