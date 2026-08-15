package com.idebridge.jetbrains.service

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger

/**
 * Application-level service that maps JetBrains dumb/smart mode states to
 * IDEBP readiness states.
 *
 * IDEBP readiness states (TASK.md §13):
 *   - initializing
 *   - indexing
 *   - ready
 *   - degraded
 *   - disconnected
 *
 * JetBrains mapping:
 *   - Project opening → initializing
 *   - Dumb mode (indexing) → indexing
 *   - Smart mode → ready
 *   - Partial index / background → degraded
 *   - Project closed / daemon disconnected → disconnected
 *
 * ARCHITECTURE RULE: Index-dependent capabilities are disabled during dumb mode.
 * Operations requiring indexes return INDEX_NOT_READY (retriable error).
 */
@Service(Service.Level.APP)
class ReadinessManager {

    private val logger = logger<ReadinessManager>()

    enum class ReadinessState {
        INITIALIZING,
        INDEXING,
        READY,
        DEGRADED,
        DISCONNECTED
    }

    @Volatile
    private var state: ReadinessState = ReadinessState.DISCONNECTED

    fun getState(): ReadinessState = state

    fun setState(newState: ReadinessState) {
        if (newState != state) {
            logger.info("[IDE Bridge] Readiness state transition: $state → $newState")
            state = newState
            // Phase 4: emit workspace/readinessChanged notification,
            // update capability availability announcements.
        }
    }

    /**
     * Returns true if index-dependent capabilities are available.
     * During dumb mode (INDEXING), index-dependent operations must return
     * INDEX_NOT_READY.
     */
    fun isIndexReady(): Boolean = state == ReadinessState.READY || state == ReadinessState.DEGRADED

    companion object {
        @JvmStatic
        fun getInstance(): ReadinessManager =
            ApplicationManager.getApplication().getService(ReadinessManager::class.java)
    }
}
