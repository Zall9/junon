package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.protocol.ReadinessState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReadinessModelTest {
    @Test
    fun `dumb mode reports indexing with the operations it blocks`() {
        val status = ReadinessModel.status("ws_1", ReadinessModel.IndexState.DUMB)

        assertEquals(ReadinessState.INDEXING, status.state)
        assertTrue("workspace/searchSymbols" in status.capabilitiesUnavailable)
        assertTrue("symbol/getReferences" in status.capabilitiesUnavailable)
        // Progress is reported as unknown rather than invented: the platform usually shows an
        // indeterminate indicator, not a percentage.
        assertEquals(false, status.progress.known)
        assertEquals(null, status.progress.percentage)
    }

    @Test
    fun `smart mode reports ready with nothing unavailable`() {
        val status = ReadinessModel.status("ws_1", ReadinessModel.IndexState.SMART)

        assertEquals(ReadinessState.READY, status.state)
        assertTrue(status.capabilitiesUnavailable.isEmpty())
    }

    @Test
    fun `maps every index state to its readiness state`() {
        assertEquals(
            ReadinessState.INITIALIZING,
            ReadinessModel.status("ws_1", ReadinessModel.IndexState.INITIALIZING).state,
        )
        assertEquals(
            ReadinessState.DISCONNECTED,
            ReadinessModel.status("ws_1", ReadinessModel.IndexState.DISCONNECTED).state,
        )
    }

    @Test
    fun `document reads stay available while indexes are unusable`() {
        // A document read needs the document, not the index. Reporting it as unavailable would
        // deny an operation the IDE can perfectly well answer in dumb mode.
        //
        // `BLOCKED` is excluded because it is not a statement about indexes at all: it means the
        // IDE cannot run a read action, and a document read needs one like everything else. That
        // case is `ReadinessWatchdogTest`'s.
        val indexStates = ReadinessModel.IndexState.entries - ReadinessModel.IndexState.BLOCKED
        for (state in indexStates) {
            assertTrue(!ReadinessModel.isBlocked("document/read", state))
            assertTrue(!ReadinessModel.isBlocked("document/getRevision", state))
        }
    }

    @Test
    fun `index-dependent operations are blocked only outside smart mode`() {
        assertTrue(
            ReadinessModel.isBlocked("workspace/searchSymbols", ReadinessModel.IndexState.DUMB),
        )
        assertTrue(
            !ReadinessModel.isBlocked("workspace/searchSymbols", ReadinessModel.IndexState.SMART),
        )
    }
}
