package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.Location
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.intellij.psi.search.PsiTodoSearchHelper

/**
 * The IDE's own TODO markers.
 *
 * `PsiTodoSearchHelper` is a platform service, and the patterns it matches are the ones configured
 * in the IDE's settings — `TODO`, `FIXME`, and whatever the user added. No pattern is written here,
 * so a project that marks work with its own keyword is served without this adapter knowing it
 * exists.
 *
 * Callers must already hold a read action.
 */
public object IntelliJTodos {

    /** One marker: where it is, what it says, and which configured pattern matched. */
    public data class Item(val location: Location, val text: String, val pattern: String?)

    public data class Found(val items: List<Item>, val truncated: Boolean)

    /**
     * Markers in [file], up to [limit].
     *
     * Text is taken from the marker's own range rather than the whole comment: a block comment can
     * carry paragraphs around a single `TODO`, and returning all of it would bury the marker in
     * prose the author never meant as the task.
     */
    public fun inFile(project: Project, file: PsiFile, limit: Int): Found {
        val helper = PsiTodoSearchHelper.getInstance(project)
        val uri = file.virtualFile?.url ?: return Found(emptyList(), false)
        val index = LineIndex(file.text)
        val items = mutableListOf<Item>()
        var seen = 0

        for (occurrence in helper.findTodoItems(file)) {
            seen += 1
            if (items.size >= limit) continue
            val range = occurrence.textRange
            if (!index.covers(range.startOffset, range.endOffset)) continue
            val text = file.text.substring(range.startOffset, range.endOffset).trim()
            if (text.isEmpty()) continue
            items.add(
                Item(
                    location = Location(
                        uri = uri,
                        range = index.range(range.startOffset, range.endOffset),
                        positionEncoding = PositionEncoding.UTF16,
                    ),
                    text = text.take(MAX_TEXT),
                    // The IDE names its own pattern; this adapter never interprets it.
                    pattern = runCatching { occurrence.pattern?.patternString }.getOrNull(),
                ),
            )
        }
        return Found(items, truncated = seen > items.size)
    }

    /**
     * Markers across the whole project, up to [limit].
     *
     * `findFilesWithTodoItems` is the IDE's own index answering which files carry markers at all —
     * enumerating every source file and scanning it here would reimplement that index badly and
     * scale with the project rather than with the number of TODOs.
     */
    public fun inProject(project: Project, limit: Int): Found {
        val helper = PsiTodoSearchHelper.getInstance(project)
        val items = mutableListOf<Item>()
        var truncated = false

        // `processFilesWithTodoItems` rather than the deprecated `findFilesWithTodoItems`, which
        // materialises every matching file before the first is read. The processor stops as soon as
        // the limit is reached, so a repository with thousands of markers costs the same as one.
        //
        // It scans across threads and **requires a progress indicator**: without one it throws
        // `progress indicator is required`, which the adapter turned into a bare `PROVIDER_FAILED`
        // with the cause discarded. The adapter runs headless behind a socket, so there is no
        // progress UI to attach — an empty indicator satisfies the contract without inventing one.
        com.intellij.openapi.progress.ProgressManager.getInstance().runProcess({
            helper.processFilesWithTodoItems { file ->
                if (items.size >= limit) {
                    truncated = true
                    return@processFilesWithTodoItems false
                }
                val found = inFile(project, file, limit - items.size)
                items.addAll(found.items)
                truncated = truncated || found.truncated
                true
            }
        }, com.intellij.openapi.progress.EmptyProgressIndicator())
        return Found(items.take(limit), truncated)
    }

    /** Matches the protocol ceiling; a longer string would be refused on the wire. */
    private const val MAX_TEXT = 500
}
