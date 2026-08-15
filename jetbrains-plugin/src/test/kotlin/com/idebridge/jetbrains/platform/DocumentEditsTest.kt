package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.EditOperation
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Reformatting and import optimisation, run by the IDE's own engines.
 *
 * These are the two operations that prove the plan model generalises beyond rename: neither needs a
 * symbol or an argument, so what is exercised is the machinery itself. `CodeStyleManager` and
 * `OptimizeImportsProcessor` are platform services backed per language, so the same code reformats
 * PHP in PhpStorm and Go in GoLand — this test names Java only because that is what this IDE parses.
 */
class DocumentEditsTest : BasePlatformTestCase() {

    fun `test reformatting rewrites layout using the IDE's own formatter`() {
        val file = myFixture.configureByText(
            "Service.java",
            "class Service {\n" +
                "int value;\n" +
                "        void run() {   }\n" +
                "}\n",
        )
        val before = file.text

        WriteCommandAction.runWriteCommandAction(project) {
            IntelliJDocumentEdits.apply(EditOperation.REFORMAT, file)
        }

        assertFalse("the formatter must have changed the layout", file.text == before)
        // Layout only: the declarations are still there, unchanged in meaning.
        assertTrue(file.text.contains("int value;"))
        assertTrue(file.text.contains("void run()"))
    }

    fun `test reformatting an already-formatted file changes nothing`() {
        val file = myFixture.configureByText(
            "Tidy.java",
            "class Tidy {\n    int value;\n}\n",
        )
        val before = file.text

        WriteCommandAction.runWriteCommandAction(project) {
            IntelliJDocumentEdits.apply(EditOperation.REFORMAT, file)
        }

        // A no-op is a legitimate outcome, and the content hash is what reports it. An adapter that
        // claimed a modification here would have a consumer believe an edit landed.
        assertEquals(before, file.text)
    }

    fun `test optimising imports removes what the file does not use`() {
        val file = myFixture.configureByText(
            "Imports.java",
            "import java.util.List;\n" +
                "import java.util.Map;\n" +
                "\n" +
                "class Imports {\n" +
                "    Map<String, String> values;\n" +
                "}\n",
        )

        WriteCommandAction.runWriteCommandAction(project) {
            IntelliJDocumentEdits.apply(EditOperation.OPTIMIZE_IMPORTS, file)
        }

        assertFalse("the unused import must be gone: ${file.text}", file.text.contains("java.util.List"))
        assertTrue("the used one must remain", file.text.contains("java.util.Map"))
    }

    fun `test the guarantee reflects what each operation actually changes`() {
        // Reformatting rewrites layout, never meaning; imports change what the file references.
        // Claiming `semantic` for both would overstate the first.
        assertEquals(
            com.idebridge.jetbrains.protocol.Guarantee.SYNTACTIC,
            IntelliJDocumentEdits.guarantee(EditOperation.REFORMAT),
        )
        assertEquals(
            com.idebridge.jetbrains.protocol.Guarantee.SEMANTIC,
            IntelliJDocumentEdits.guarantee(EditOperation.OPTIMIZE_IMPORTS),
        )
    }

    fun `test it refuses an operation it cannot perform`() {
        val file = myFixture.configureByText("Service.java", "class Service {}\n")

        // Silently doing nothing would report a successful edit that never happened.
        assertThrows(IllegalStateException::class.java) {
            WriteCommandAction.runWriteCommandAction(project) {
                IntelliJDocumentEdits.apply(EditOperation.EXTRACT_METHOD, file)
            }
        }
    }
}
