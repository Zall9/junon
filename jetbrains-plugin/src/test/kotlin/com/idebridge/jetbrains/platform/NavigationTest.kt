package com.idebridge.jetbrains.platform

import com.intellij.psi.PsiFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Navigation, against the IDE's own search engines.
 *
 * `ReferencesSearch` and `DefinitionsScopedSearch` are platform services each language plugin backs,
 * so what is exercised here is real resolution over a real index — not a text scan. Java is the
 * sample; nothing in the code under test names it.
 */
class NavigationTest : BasePlatformTestCase() {

    private fun configure(): PsiFile {
        myFixture.addFileToProject(
            "Caller.java",
            """
            class Caller {
                int use(Service service) {
                    return service.value() + service.value();
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
        )
    }

    private fun method(file: PsiFile) =
        IntelliJNavigation.declarationAt(file, file.text.indexOf("value"))!!

    fun `test a declaration is its own definition, at its identifier`() {
        val file = configure()

        val found = IntelliJNavigation.definition(method(file))

        val location = found.locations.single()
        assertTrue("must point at this file", location.uri.endsWith("Service.java"))
        // The identifier, not the whole method: a consumer navigating here lands on the name.
        assertEquals(1, location.range.start.line)
        assertFalse(found.truncated)
    }

    fun `test references are found across files by the IDE's index`() {
        val file = configure()

        val found = IntelliJNavigation.references(project, method(file))

        // Two call sites in Caller.java. A text scan would also match the declaration; resolution
        // does not, which is the difference this exercises.
        assertEquals("expected both call sites, got: ${found.locations}", 2, found.locations.size)
        assertTrue(found.locations.all { it.uri.endsWith("Caller.java") })
        assertFalse(found.truncated)
    }

    fun `test the declaration at an offset is the declaration, not the token`() {
        val file = configure()

        val declaration = IntelliJNavigation.declarationAt(file, file.text.indexOf("value"))

        // A bare identifier token is not addressable by a locator, so the named declaration
        // containing it is what a consumer asking "what is here" means.
        assertNotNull(declaration)
        assertEquals("value", declaration!!.name)
    }

    fun `test an offset in no declaration answers nothing rather than guessing`() {
        val file = myFixture.configureByText("Blank.java", "\n\nclass Blank {}\n")

        assertNull(IntelliJNavigation.declarationAt(file, 0))
    }

    fun `test implementations of an interface method come from the IDE`() {
        myFixture.addFileToProject(
            "Impl.java",
            """
            class Impl implements Runner {
                public void run() {}
            }
            """.trimIndent(),
        )
        val file = myFixture.configureByText(
            "Runner.java",
            """
            interface Runner {
                void run();
            }
            """.trimIndent(),
        )
        val declaration = IntelliJNavigation.declarationAt(file, file.text.indexOf("run"))!!

        val found = IntelliJNavigation.implementations(declaration)

        assertTrue(
            "the implementation must be found: ${found.locations}",
            found.locations.any { it.uri.endsWith("Impl.java") },
        )
    }
}
