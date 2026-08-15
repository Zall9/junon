package com.idebridge.jetbrains.platform

import com.intellij.openapi.application.ReadAction
import com.intellij.psi.PsiDocumentManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Resolving a published `fixId` back to the action it named.
 *
 * The id is a digest, so it cannot be dereferenced — it is re-derived from the document's current
 * highlights. That is what makes the resolution fail closed: if the document changed or the offer is
 * gone, nothing matches and the request is refused, rather than applying whichever fix now sits in
 * that position. A stored handle would have to detect the same staleness on purpose, and getting
 * that wrong means silently applying a fix nobody chose.
 */
class ResolveFixTest : BasePlatformTestCase() {

    private fun configure(source: String) =
        myFixture.configureByText("Service.java", source)

    private fun document() =
        PsiDocumentManager.getInstance(project).getDocument(myFixture.file)!!

    private fun offeredFixIds(): List<String> {
        myFixture.doHighlighting()
        return ReadAction.compute<List<String>, RuntimeException> {
            IntelliJDiagnostics.highlights(project, document()).flatMap { it.fixes }.map { it.fixId }
        }
    }

    fun `test a published id resolves to an action`() {
        configure(
            """
            class Service {
                private int count = "not an int";
            }
            """.trimIndent(),
        )
        val fixId = offeredFixIds().firstOrNull()
            ?: error("the fixture must offer at least one fix to resolve")

        val action = ReadAction.compute<Any?, RuntimeException> {
            IntelliJDiagnostics.resolveFix(project, document(), fixId)
        }

        assertNotNull("a published id must resolve back to its action", action)
    }

    fun `test an id from a stale snapshot resolves to nothing`() {
        configure(
            """
            class Service {
                private int count = "not an int";
            }
            """.trimIndent(),
        )
        val fixId = offeredFixIds().firstOrNull()
            ?: error("the fixture must offer at least one fix to resolve")

        // Deliberately a *different* error rather than none. An earlier version of this test made
        // the file clean, which meant no offers existed and the resolution returned null whatever
        // the code did — it passed with id matching mutated away, so it proved nothing. The
        // document must still be offering fixes, just not the one that was published.
        configure(
            """
            class Service {
                private String count = 42;
            }
            """.trimIndent(),
        )
        assertTrue(
            "the rewritten fixture must still offer fixes, or this test is vacuous",
            offeredFixIds().isNotEmpty(),
        )
        assertFalse("the offer must have changed", offeredFixIds().contains(fixId))

        val action = ReadAction.compute<Any?, RuntimeException> {
            IntelliJDiagnostics.resolveFix(project, document(), fixId)
        }

        assertNull("an offer from a superseded snapshot must not resolve", action)
    }

    fun `test an invented id resolves to nothing`() {
        configure(
            """
            class Service {
                private int count = "not an int";
            }
            """.trimIndent(),
        )
        myFixture.doHighlighting()

        val action = ReadAction.compute<Any?, RuntimeException> {
            IntelliJDiagnostics.resolveFix(project, document(), "0".repeat(32))
        }

        assertNull("an id this adapter never published must not resolve", action)
    }
}
