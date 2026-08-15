package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.SymbolKind
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * `workspace/searchSymbols` narrows by kind, or it is lying to its caller.
 *
 * The protocol has always declared `kinds`, and the VS Code adapter has always applied it. This one
 * accepted the parameter and dropped it on the floor — found on 2026-08-11 by asking a real
 * PhpStorm for `class` and receiving two methods among the classes. Two adapters answering the same
 * request differently is the drift the shared rules exist to prevent, and a filter that is ignored
 * is worse than one that is refused: it returns a wrong answer in the shape of a right one.
 *
 * The filter is applied while results are collected rather than to a finished page, and the test
 * below for the limit is what holds that: filtering afterwards would answer "one class" for a file
 * holding several and call the answer complete.
 */
class SymbolSearchKindFilterTest : BasePlatformTestCase() {

    private fun fixture() {
        myFixture.configureByText(
            "Search.java",
            """
            class SearchTarget {
                void searchMethod() {}
                int searchField;
            }

            interface SearchContract {
                void searchOperation();
            }
            """.trimIndent(),
        )
    }

    private fun search(limit: Int = 50, kinds: Set<SymbolKind>? = null): List<String> {
        fixture()
        return IntelliJSymbolSearch.search(project, "search", limit, kinds)
            .elements
            .mapNotNull { it.name }
    }

    fun `test without a filter every kind comes back`() {
        val names = search()

        assertTrue("expected a class and a method, got: $names", names.contains("SearchTarget"))
        assertTrue(names.contains("searchMethod"))
    }

    fun `test a class filter excludes methods and fields`() {
        val names = search(kinds = setOf(SymbolKind.CLASS))

        assertTrue("classes must survive: $names", names.contains("SearchTarget"))
        assertFalse("a method is not a class: $names", names.contains("searchMethod"))
        assertFalse("a field is not a class: $names", names.contains("searchField"))
    }

    fun `test a filter may name several kinds`() {
        val names = search(kinds = setOf(SymbolKind.METHOD, SymbolKind.FIELD))

        assertTrue(names.contains("searchMethod"))
        assertTrue(names.contains("searchField"))
        assertFalse(names.contains("SearchTarget"))
    }

    fun `test an excluded kind does not spend the caller's limit`() {
        // The whole reason the filter runs during collection. With a limit of 2 and the filter
        // applied afterwards, the two methods found first would be discarded and the answer would be
        // empty — while reporting nothing was missing.
        val names = search(limit = 2, kinds = setOf(SymbolKind.CLASS, SymbolKind.INTERFACE))

        assertEquals(
            "both declarations must fit within a limit that only counts matches: $names",
            setOf("SearchTarget", "SearchContract"),
            names.toSet(),
        )
    }

    fun `test an empty filter asks for nothing and gets nothing`() {
        // Distinct from `null`, which means every kind. A caller that computed an empty set should
        // receive nothing rather than everything.
        assertTrue(search(kinds = emptySet()).isEmpty())
    }
}
