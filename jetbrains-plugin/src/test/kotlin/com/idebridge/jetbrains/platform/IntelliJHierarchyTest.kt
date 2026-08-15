package com.idebridge.jetbrains.platform

import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises one hierarchy step against the IDE's real resolution.
 *
 * The distinction these tests hold is the one that makes a hierarchy a hierarchy rather than a
 * reference list: a caller is the *declaration containing* a reference, not the reference itself.
 * Getting that wrong produces a plausible-looking result that points at call sites, which is what a
 * consumer already gets from `symbol/getReferences`.
 */
class IntelliJHierarchyTest : BasePlatformTestCase() {

    private fun configure(): PsiJavaFile {
        myFixture.addFileToProject(
            "Caller.java",
            """
            class Caller {
                int outer() {
                    return new Service().value();
                }
            }
            """.trimIndent(),
        )
        return myFixture.configureByText(
            "Service.java",
            """
            class Service {
                int value() {
                    return helper();
                }

                int helper() {
                    return 1;
                }
            }
            """.trimIndent(),
        ) as PsiJavaFile
    }

    private fun method(file: PsiJavaFile, name: String) =
        file.classes.single().methods.single { it.name == name }

    fun `test callers are the declarations containing a reference, not the reference`() {
        val file = configure()

        val outcome = IntelliJHierarchy.of(project, method(file, "value"), IntelliJHierarchy.Relation.CALLERS)

        val found = assertInstanceOf(outcome, IntelliJHierarchy.Outcome.Found::class.java)
        assertEquals(1, found.locations.size)
        val caller = found.locations.single()
        assertTrue("caller should be in Caller.java, was ${caller.uri}", caller.uri.endsWith("Caller.java"))
        // Line 1 is `int outer()`. Pointing at line 2 would mean it reported the call site.
        assertEquals(1, caller.range.start.line)
    }

    fun `test callees are what a declaration reaches, excluding itself`() {
        val file = configure()

        val outcome = IntelliJHierarchy.of(project, method(file, "value"), IntelliJHierarchy.Relation.CALLEES)

        val found = assertInstanceOf(outcome, IntelliJHierarchy.Outcome.Found::class.java)
        val names = found.locations.map { it.range.start.line }
        assertEquals("expected exactly the helper declaration, got $names", 1, found.locations.size)
        // `int helper()` sits on line 5.
        assertEquals(5, found.locations.single().range.start.line)
    }

    fun `test supertypes are refused rather than approximated`() {
        val file = configure()

        val outcome =
            IntelliJHierarchy.of(project, method(file, "value"), IntelliJHierarchy.Relation.SUPERTYPES)

        assertEquals(IntelliJHierarchy.Outcome.UnsupportedRelation, outcome)
    }
}
