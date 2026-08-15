package com.idebridge.jetbrains.service

import java.util.concurrent.ConcurrentHashMap

/**
 * Turns a stream of keystrokes into one announcement per document.
 *
 * TASK.md §12 requires a document change to invalidate the plans and handles concerned, and says the
 * MVP need not forward every text change. Both halves matter: an adapter that sent nothing left the
 * daemon holding plans against documents the user had already rewritten, and an adapter that sent
 * one notification per keystroke would flood every consumer, since the daemon broadcasts each one.
 *
 * So changes are coalesced per document and announced after a quiet interval. The listener side does
 * almost nothing — it records a URI — because it runs on the IDE's event thread, and work there is
 * work taken from the person typing.
 *
 * The scheduler is a parameter so the debounce is testable without waiting for a timer, and so the
 * production wiring can put the announcement on a pooled thread where the read action it needs is
 * allowed to block.
 */
public class DocumentChangeAnnouncer(
    private val schedule: (Runnable) -> Unit,
    private val announce: (String) -> Unit,
) {
    /** URIs waiting to be announced. A repeat while one is pending changes nothing. */
    private val pending = ConcurrentHashMap.newKeySet<String>()

    /** Records a change. Cheap by design: this is called from the editor's own thread. */
    public fun noteChanged(uri: String) {
        // Scheduled only when the URI was not already waiting, so a burst of typing schedules one
        // flush rather than one per character.
        if (pending.add(uri)) schedule(Runnable { flush(uri) })
    }

    /**
     * Announces [uri] if it is still pending.
     *
     * Removed before announcing, not after: a change arriving *during* the announcement must
     * schedule another one, or the last keystroke of a burst would be the one nobody hears about.
     */
    public fun flush(uri: String) {
        if (!pending.remove(uri)) return
        announce(uri)
    }

    /** Drops everything waiting, for a link that is ending. */
    public fun cancel() {
        pending.clear()
    }

    public fun isPending(uri: String): Boolean = pending.contains(uri)
}
