package com.idebridge.jetbrains.edit

/**
 * Runs a mutation where the IDE allows one.
 *
 * The daemon delivers a request on a background thread, but changing PSI requires the dispatch
 * thread inside a write action. That constraint is the whole reason this abstraction exists: the
 * routing and the plan bookkeeping stay testable without an IDE, and only the implementation knows
 * about threads.
 *
 * Implementations must run the block to completion before returning: an edit that is still in
 * flight when the response is sent would report a modification the consumer cannot yet observe.
 */
public interface EditScheduler {
    public fun <T> runWrite(block: () -> T): T

    public companion object {
        /** Runs inline. For tests and for callers already holding the right context. */
        public val Direct: EditScheduler = object : EditScheduler {
            override fun <T> runWrite(block: () -> T): T = block()
        }
    }
}
