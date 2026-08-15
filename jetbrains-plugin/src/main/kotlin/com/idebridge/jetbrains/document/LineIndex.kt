package com.idebridge.jetbrains.document

import com.idebridge.jetbrains.protocol.Position
import com.idebridge.jetbrains.protocol.Range

/**
 * Offset-to-position conversion for one document snapshot.
 *
 * The platform reports everything — declarations, diagnostics, edit ranges — as text offsets, while
 * IDEBP speaks line/character positions. This is the single place that converts, so every feature
 * agrees on what a position means.
 *
 * A character offset is an index into a UTF-16 sequence, which is exactly what the protocol's
 * `utf-16` encoding means and what a Kotlin `CharSequence` index already is, so nothing is
 * re-encoded. Only `\n` starts a line: an IntelliJ `Document` normalises line separators, and
 * treating a lone `\r` as a break would disagree with the offsets the platform hands back.
 */
public class LineIndex(text: CharSequence) {
    private val lineStarts: IntArray
    private val length: Int = text.length

    init {
        val starts = mutableListOf(0)
        for (index in text.indices) if (text[index] == '\n') starts.add(index + 1)
        lineStarts = starts.toIntArray()
    }

    public fun position(offset: Int): Position {
        require(offset in 0..length) { "Offset is outside the document" }
        var low = 0
        var high = lineStarts.size - 1
        while (low < high) {
            val middle = (low + high + 1) / 2
            if (lineStarts[middle] <= offset) low = middle else high = middle - 1
        }
        return Position(line = low, character = offset - lineStarts[low])
    }

    public fun range(startOffset: Int, endOffset: Int): Range {
        require(startOffset <= endOffset) { "Range end precedes its start" }
        return Range(position(startOffset), position(endOffset))
    }

    /**
     * The offset of [position], or `null` when it does not address this snapshot.
     *
     * The counterpart of [position]: a consumer asks about a line and column, while the platform
     * works in offsets. Returns `null` rather than clamping, because a position past the end of a
     * line is a question about text that is not there, and answering it with the nearest offset
     * would resolve a symbol the caller never pointed at.
     */
    public fun offsetOf(position: com.idebridge.jetbrains.protocol.Position): Int? {
        if (position.line !in lineStarts.indices) return null
        val start = lineStarts[position.line]
        val end = if (position.line + 1 < lineStarts.size) lineStarts[position.line + 1] - 1 else length
        val offset = start + position.character
        return if (offset in start..end) offset else null
    }

    /** True when both offsets address this snapshot, so a caller can skip rather than throw. */
    public fun covers(startOffset: Int, endOffset: Int): Boolean =
        startOffset in 0..length && endOffset in startOffset..length
}
