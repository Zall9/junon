package com.idebridge.jetbrains.platform

import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises the rename against the IDE's real refactoring engine.
 *
 * The plan bookkeeping is covered without the platform in `RenamePlanRegistryTest`. What only a
 * real project can answer is whether the engine finds the usages, whether preparing leaves the
 * files untouched — the whole point of two phases — and whether applying rewrites references the
 * declaration alone would have missed.
 */
class IntelliJRenameTest : BasePlatformTestCase() {

    private fun configure(): PsiJavaFile {
        myFixture.addFileToProject(
            "Caller.java",
            """
            class Caller {
                int use(Service service) {
                    return service.value() + new Service().value();
                }
            }
            """.trimIndent(),
        )
        return myFixture.configureByText(
            "Service.java",
            """
            class Service {
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        ) as PsiJavaFile
    }

    private fun method(file: PsiJavaFile) = file.classes.single().methods.single()

    fun `test preparing finds usages across files and changes nothing`() {
        val file = configure()
        val before = file.text

        val outcome = IntelliJRename.prepare(project, method(file), "amount")

        val ready = outcome as IntelliJRename.Outcome.Ready
        val uris = ready.prepared.changes.map { it.uri }
        assertEquals("both files must be in the plan, got: $uris", 2, uris.size)
        assertTrue(uris.any { it.endsWith("Service.java") })
        assertTrue(uris.any { it.endsWith("Caller.java") })
        assertTrue("every change must count at least one edit", ready.prepared.changes.all { it.editCount >= 1 })

        // Preparing must not touch the document: that is the entire reason the operation has two
        // phases rather than one.
        assertEquals(before, file.text)
    }

    fun `test applying renames the declaration and its references`() {
        val file = configure()
        val prepared = (IntelliJRename.prepare(project, method(file), "amount")
            as IntelliJRename.Outcome.Ready).prepared

        IntelliJRename.apply(prepared)

        assertTrue("the declaration is renamed, got:\n" + file.text, file.text.contains("int amount()"))
        assertFalse("the old name is gone from the declaration", file.text.contains("int value()"))

        // Read through the PSI rather than the raw VFS bytes: the refactoring edits the in-memory
        // document, which is not flushed to disk in a fixture, so raw bytes would show stale text
        // and the assertion would be measuring the fixture rather than the rename.
        val caller = myFixture.findFileInTempDir("Caller.java")
        val callerText = com.intellij.psi.PsiManager.getInstance(project)
            .findFile(caller)!!
            .text
        // A rename that only rewrote the declaration would leave these calls broken, which is the
        // difference between a semantic refactoring and a textual replacement.
        assertTrue("references are renamed too: $callerText", callerText.contains("service.amount()"))
        assertTrue(callerText.contains("new Service().amount()"))
        assertFalse(callerText.contains(".value()"))
    }

    fun `test an element the engine cannot rename is refused, not attempted`() {
        val file = myFixture.configureByText(
            "Literal.java",
            """
            class Literal {
                int value = 1 + 2;
            }
            """.trimIndent(),
        ) as PsiJavaFile

        // A binary expression is not a declaration; the engine has nothing to rename.
        val expression = file.classes.single().fields.single().initializer!!
        val outcome = IntelliJRename.prepare(project, expression, "whatever")

        assertTrue(
            "an unrenamable element must be refused: $outcome",
            outcome is IntelliJRename.Outcome.Refused,
        )
    }

    fun `test comment and string occurrences are excluded from the plan`() {
        myFixture.addFileToProject(
            "Mentions.java",
            """
            class Mentions {
                // value() is mentioned here
                String s = "value()";
            }
            """.trimIndent(),
        )
        val file = configure()

        val ready = IntelliJRename.prepare(project, method(file), "amount")
            as IntelliJRename.Outcome.Ready

        // Textual matches in comments and strings are not references. Counting them would make the
        // plan's `semantic` guarantee untrue for part of the change.
        assertTrue(
            "no plan entry may point at the file that only mentions the name in text",
            ready.prepared.changes.none { it.uri.endsWith("Mentions.java") },
        )
    }
}
