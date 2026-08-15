package com.idebridge.jetbrains.platform

import com.intellij.ide.bookmark.BookmarksManager
import com.intellij.ide.bookmark.providers.LineBookmarkProvider
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The user's bookmarks, read from the IDE.
 *
 * What these hold is the distinction that makes a bookmark a bookmark: it is the user saying "this
 * matters" and nothing more. It carries no severity and no task text, so an adapter that dressed one
 * up as a diagnostic or a TODO would attribute an intent the user never expressed.
 */
class IntelliJBookmarksTest : BasePlatformTestCase() {

    /**
     * `BasePlatformTestCase` reuses one project across a class, and bookmarks live on the project —
     * so a bookmark added by one test was still there for the next, and the "no bookmarks" case
     * passed or failed depending on the order the runner chose. Cleared explicitly rather than left
     * to ordering.
     */
    override fun tearDown() {
        try {
            BookmarksManager.getInstance(project)?.let { manager ->
                manager.bookmarks.forEach(manager::remove)
            }
        } finally {
            super.tearDown()
        }
    }

    private fun configure() =
        myFixture.configureByText(
            "Service.java",
            """
            class Service {
                int value() {
                    return 1;
                }
            }
            """.trimIndent(),
        )

    fun `test a project with no bookmarks reports none rather than truncating`() {
        configure()

        val found = IntelliJBookmarks.of(project, 10)

        assertEquals(0, found.items.size)
        // "The user has none" is a different answer from "there may be more".
        assertFalse(found.truncated)
    }

    fun `test a line bookmark is reported at its line`() {
        val file = configure()
        val manager = BookmarksManager.getInstance(project)
            ?: error("the platform must provide a bookmarks manager")
        val provider = LineBookmarkProvider.find(project)
            ?: error("the platform must provide a line bookmark provider")
        val bookmark = provider.createBookmark(file.virtualFile, 1)
            ?: error("the fixture must produce a line bookmark")
        manager.add(bookmark, com.intellij.ide.bookmark.BookmarkType.DEFAULT)

        val found = IntelliJBookmarks.of(project, 10)

        assertEquals(1, found.items.size)
        val item = found.items.single()
        assertEquals(1, item.location.range.start.line)
        // A line bookmark marks a line, not a span: reporting a width would be a guess at what on
        // the line the user meant.
        assertEquals(item.location.range.start.line, item.location.range.end.line)
        assertEquals(item.location.range.start.character, item.location.range.end.character)
    }
}
