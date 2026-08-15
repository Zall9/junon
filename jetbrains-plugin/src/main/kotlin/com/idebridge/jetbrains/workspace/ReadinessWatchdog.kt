package com.idebridge.jetbrains.workspace

/**
 * Notices when the IDE has stopped answering, and says so once.
 *
 * `workspace/getStatus` is served by the daemon from the last `workspace/readinessChanged` this
 * adapter pushed — the request never reaches the IDE. So a readiness that is only announced on
 * index transitions describes the IDE's *last known* state for ever. Measured on 2026-08-14:
 * `ready` in 0.00 s while `document/read`, `document/getSymbols` and `workspace/searchSymbols` all
 * failed at exactly the 30 s route timeout, the IDE having blocked on a modal dialog. A consumer
 * polling readiness would have waited indefinitely for a state that was never coming back.
 *
 * Deliberately not a poller of the IDE's internals: it asks the same question the routes ask — can a
 * read action run right now — because a probe that measures something else would report health the
 * routes do not have.
 *
 * Announcing only on change is the point. A degraded IDE would otherwise emit a notification per
 * tick for as long as it stayed stuck, and the daemon broadcasts every one of them to every
 * consumer.
 */
public class ReadinessWatchdog(
    private val probe: () -> Boolean,
    private val indexState: () -> ReadinessModel.IndexState,
    private val publish: (ReadinessModel.IndexState) -> Unit,
) {
    private var announced: ReadinessModel.IndexState? = null

    /**
     * One check. Returns the state it settled on, whether or not it announced.
     *
     * A blocked IDE outranks whatever the index is doing: indexes may be perfectly built, and it
     * still cannot answer.
     */
    public fun tick(): ReadinessModel.IndexState {
        val state = if (probe()) indexState() else ReadinessModel.IndexState.BLOCKED
        if (state != announced) {
            announced = state
            publish(state)
        }
        return state
    }

    /**
     * Forgets what was announced, so the next tick announces again.
     *
     * Used when a session ends: the next one starts with a daemon that knows nothing, and a
     * watchdog still holding the old value would stay silent until the state happened to change.
     */
    public fun reset() {
        announced = null
    }
}
