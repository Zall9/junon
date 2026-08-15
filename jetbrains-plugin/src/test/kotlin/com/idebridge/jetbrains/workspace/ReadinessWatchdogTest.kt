package com.idebridge.jetbrains.workspace

import junit.framework.TestCase

/**
 * What readiness must stop doing: describing the past.
 *
 * `workspace/getStatus` is answered by the daemon from the adapter's last announcement, so an
 * adapter that announces only on index transitions leaves `ready` standing for ever once the IDE
 * stops answering. Measured on 2026-08-14: `ready` in 0.00 s while three routes failed at exactly
 * the 30 s route timeout.
 */
class ReadinessWatchdogTest : TestCase() {

    private class Recorder {
        val published = mutableListOf<ReadinessModel.IndexState>()
        var canServe = true
        var index = ReadinessModel.IndexState.SMART

        fun watchdog() = ReadinessWatchdog(
            probe = { canServe },
            indexState = { index },
            publish = { published.add(it) },
        )
    }

    fun `test an IDE that cannot answer is degraded, whatever its indexes say`() {
        val recorder = Recorder()
        val watchdog = recorder.watchdog()
        watchdog.tick()

        recorder.canServe = false
        val state = watchdog.tick()

        assertEquals(ReadinessModel.IndexState.BLOCKED, state)
        assertEquals(
            listOf(ReadinessModel.IndexState.SMART, ReadinessModel.IndexState.BLOCKED),
            recorder.published,
        )
    }

    fun `test a blocked IDE outranks a healthy index`() {
        val recorder = Recorder()
        recorder.canServe = false
        recorder.index = ReadinessModel.IndexState.SMART

        assertEquals(ReadinessModel.IndexState.BLOCKED, recorder.watchdog().tick())
    }

    fun `test it announces only when the state changes`() {
        val recorder = Recorder()
        val watchdog = recorder.watchdog()

        repeat(5) { watchdog.tick() }
        recorder.canServe = false
        repeat(5) { watchdog.tick() }
        recorder.canServe = true
        repeat(5) { watchdog.tick() }

        // Three transitions, fifteen ticks. The daemon broadcasts each announcement to every
        // consumer, so a stuck IDE announcing per tick would be a broadcast storm.
        assertEquals(
            listOf(
                ReadinessModel.IndexState.SMART,
                ReadinessModel.IndexState.BLOCKED,
                ReadinessModel.IndexState.SMART,
            ),
            recorder.published,
        )
    }

    fun `test recovery is announced, not merely noticed`() {
        val recorder = Recorder()
        val watchdog = recorder.watchdog()
        recorder.canServe = false
        watchdog.tick()

        recorder.canServe = true
        watchdog.tick()

        assertEquals(ReadinessModel.IndexState.SMART, recorder.published.last())
    }

    fun `test a reset makes the next tick announce again`() {
        val recorder = Recorder()
        val watchdog = recorder.watchdog()
        watchdog.tick()
        val before = recorder.published.size

        // A new session's daemon knows nothing; staying silent because the state happens to match
        // the last one would leave it with no readiness at all.
        watchdog.reset()
        watchdog.tick()

        assertEquals(before + 1, recorder.published.size)
    }

    fun `test degraded names every method it cannot serve, not only the indexed ones`() {
        val status = ReadinessModel.status("ws_test", ReadinessModel.IndexState.BLOCKED)

        assertEquals("degraded", status.state.name.lowercase())
        // A document read needs no index and is still unavailable: it needs a read action.
        assertTrue(status.capabilitiesUnavailable.contains("document/read"))
        assertTrue(status.capabilitiesUnavailable.contains("workspace/searchSymbols"))
        assertTrue(ReadinessModel.isBlocked("document/read", ReadinessModel.IndexState.BLOCKED))
        // And an indexing IDE still serves document reads, which must not regress.
        assertFalse(ReadinessModel.isBlocked("document/read", ReadinessModel.IndexState.DUMB))
    }
}
