package com.idebridge.jetbrains.service

import junit.framework.TestCase

/**
 * One announcement per document, not one per keystroke.
 *
 * The daemon broadcasts every `document/changed` to every consumer, so the difference between
 * coalescing and not is the difference between a notification and a flood. And the daemon needs at
 * least one, or its plans stay live against text the user has already rewritten (TASK.md §12).
 */
class DocumentChangeAnnouncerTest : TestCase() {

    private class Harness {
        val scheduled = mutableListOf<Runnable>()
        val announced = mutableListOf<String>()
        val announcer = DocumentChangeAnnouncer(
            schedule = { scheduled.add(it) },
            announce = { announced.add(it) },
        )

        fun runScheduled() {
            val due = scheduled.toList()
            scheduled.clear()
            for (task in due) task.run()
        }
    }

    fun `test a burst of typing announces once`() {
        val harness = Harness()

        repeat(50) { harness.announcer.noteChanged("file:///a.kt") }
        harness.runScheduled()

        assertEquals(listOf("file:///a.kt"), harness.announced)
    }

    fun `test each document is announced on its own`() {
        val harness = Harness()

        harness.announcer.noteChanged("file:///a.kt")
        harness.announcer.noteChanged("file:///b.kt")
        harness.runScheduled()

        assertEquals(setOf("file:///a.kt", "file:///b.kt"), harness.announced.toSet())
    }

    fun `test a change after the flush is announced too`() {
        val harness = Harness()
        harness.announcer.noteChanged("file:///a.kt")
        harness.runScheduled()

        // The keystroke that lands after the quiet interval must not be swallowed by the fact that
        // its document was announced a moment ago.
        harness.announcer.noteChanged("file:///a.kt")
        harness.runScheduled()

        assertEquals(listOf("file:///a.kt", "file:///a.kt"), harness.announced)
    }

    fun `test only one flush is scheduled per pending document`() {
        val harness = Harness()

        repeat(10) { harness.announcer.noteChanged("file:///a.kt") }

        // Ten keystrokes, one scheduled task: the debounce is in the scheduling, so a burst does
        // not queue ten timers that each wake a pooled thread.
        assertEquals(1, harness.scheduled.size)
    }

    fun `test cancelling drops what was waiting`() {
        val harness = Harness()
        harness.announcer.noteChanged("file:///a.kt")

        harness.announcer.cancel()
        harness.runScheduled()

        assertTrue("a link that has ended must announce nothing", harness.announced.isEmpty())
    }
}
