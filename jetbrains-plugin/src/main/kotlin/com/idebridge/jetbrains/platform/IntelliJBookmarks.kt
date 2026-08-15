package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.Location
import com.idebridge.jetbrains.protocol.Position
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Range
import com.intellij.ide.bookmark.BookmarksManager
import com.intellij.ide.bookmark.LineBookmark
import com.intellij.openapi.project.Project

/**
 * The user's own bookmarks, as the IDE holds them.
 *
 * A bookmark is the user saying "this matters", and that is all it says. It carries no severity and
 * no task text, so none is invented here — reporting one as a diagnostic or a TODO would attribute
 * an intent the user never expressed.
 *
 * Only line bookmarks are reported. The platform also bookmarks whole files and arbitrary nodes in
 * its own trees; those have no position an agent could act on, and returning them with a fabricated
 * range would be worse than omitting them.
 *
 * Callers must already hold a read action.
 */
public object IntelliJBookmarks {

    public data class Item(val location: Location, val description: String?, val group: String?)

    public data class Found(val items: List<Item>, val truncated: Boolean)

    public fun of(project: Project, limit: Int): Found {
        val manager = BookmarksManager.getInstance(project) ?: return Found(emptyList(), false)
        val all = manager.bookmarks
        val items = mutableListOf<Item>()

        for (bookmark in all) {
            if (items.size >= limit) break
            // Anything without a line has no position to report, so it is skipped rather than
            // given one.
            val line = (bookmark as? LineBookmark) ?: continue
            val uri = line.file.url
            val at = Position(line = line.line, character = 0)
            // The note belongs to the group, not the manager: a bookmark can sit in several groups
            // and carry a different description in each. The first is reported rather than merged,
            // because concatenating notes the user wrote separately would invent a sentence.
            val group = manager.getGroups(bookmark).firstOrNull()
            items.add(
                Item(
                    location = Location(
                        uri = uri,
                        // A line bookmark marks a line, not a span. The range is the line's start
                        // rather than a guess at what on it the user meant.
                        range = Range(start = at, end = at),
                        positionEncoding = PositionEncoding.UTF16,
                    ),
                    description = group?.getDescription(bookmark)?.takeIf { it.isNotBlank() },
                    group = group?.name?.takeIf { it.isNotBlank() },
                ),
            )
        }
        return Found(items, truncated = all.size > items.size)
    }
}
