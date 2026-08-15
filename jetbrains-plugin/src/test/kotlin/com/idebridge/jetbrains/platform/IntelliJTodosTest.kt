package com.idebridge.jetbrains.platform

import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * TODO markers, read through the IDE's own search.
 *
 * The patterns are the IDE's configured ones, so nothing here names `TODO` or `FIXME` as something
 * the adapter knows — a project using its own keyword is served without a change. What these tests
 * hold is the part an approximation would get wrong: the marker's own text, not the paragraph of
 * prose that happens to surround it.
 */
class IntelliJTodosTest : BasePlatformTestCase() {

    private fun configure(source: String) = myFixture.configureByText("Service.java", source)

    fun `test finds a marker and returns its own text`() {
        val file = configure(
            """
            class Service {
                // TODO rename this properly
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        )

        val found = IntelliJTodos.inFile(project, file, 10)

        assertEquals(1, found.items.size)
        assertFalse(found.truncated)
        assertTrue(
            "expected the marker's text, got ${found.items.single().text}",
            found.items.single().text.contains("rename this properly"),
        )
    }

    // A block comment can carry paragraphs around a single marker. Returning all of it would bury
    // the task in prose the author never meant as the task.
    fun `test a marker inside prose does not drag the prose with it`() {
        val file = configure(
            """
            class Service {
                /*
                 * This class exists for reasons that are long and dull to explain here.
                 * TODO split it
                 * Another paragraph nobody asked for.
                 */
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        )

        val found = IntelliJTodos.inFile(project, file, 10)

        val text = found.items.single().text
        assertTrue("expected the marker, got $text", text.contains("split it"))
        assertFalse("the surrounding prose must not travel with it", text.contains("long and dull"))
        assertFalse("nor the paragraph after it", text.contains("nobody asked for"))
    }

    fun `test a file with no markers reports none rather than truncating`() {
        val file = configure(
            """
            class Service {
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        )

        val found = IntelliJTodos.inFile(project, file, 10)

        assertEquals(0, found.items.size)
        // "The IDE looked and found none" is a different answer from "there may be more".
        assertFalse(found.truncated)
    }

    fun `test exceeding the limit is reported rather than cut silently`() {
        val file = configure(
            """
            class Service {
                // TODO one
                // TODO two
                // TODO three
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        )

        val found = IntelliJTodos.inFile(project, file, 2)

        assertEquals(2, found.items.size)
        assertTrue("a capped list presented as complete is the failure that matters", found.truncated)
    }
}
