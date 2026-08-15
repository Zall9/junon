package com.idebridge.jetbrains.service

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.Service.Level
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import kotlinx.serialization.Serializable

/**
 * Project-level service responsible for workspace registration with the daemon,
 * readiness tracking, and routing requests to PSI-based handlers.
 *
 * ARCHITECTURE RULE (AGENTS.md §3): No heavy PSI work on the EDT.
 * All PSI operations triggered from this service must use background read
 * actions and must wait for smart mode before index operations.
 *
 * Skeleton state: registration and PSI mapping logic will be implemented
 * in Phase 4.
 */
@Service(Service.Level.PROJECT)
class BridgeProjectService(private val project: Project) {

    private val logger = logger<BridgeProjectService>()

    @Volatile
    private var workspaceRegistered: Boolean = false

    /**
     * The workspace registration info sent to the daemon.
     */
    @Serializable
    data class WorkspaceInfo(
        val workspaceId: String,
        val rootUri: String,
        val displayName: String
    )

    /**
     * Registers this project's workspace with the daemon.
     * Must be called from a background thread (not EDT).
     *
     * @return the registered WorkspaceInfo, or null if registration failed
     */
    fun registerWorkspace(): WorkspaceInfo? {
        logger.info("[IDE Bridge] BridgeProjectService.registerWorkspace() for project: ${project.name}")
        // Phase 4: compute root URI from project base dir, call ide/register,
        // announce capabilities, set up event listeners.
        workspaceRegistered = false
        return null
    }

    /**
     * Unregisters this project's workspace from the daemon.
     * Called on project close. Safe to call from EDT.
     */
    fun unregisterWorkspace() {
        logger.info("[IDE Bridge] BridgeProjectService.unregisterWorkspace() for project: ${project.name}")
        // Phase 4: call ide/unregister, clean up listeners, cancel in-flight tasks.
        workspaceRegistered = false
    }

    fun isWorkspaceRegistered(): Boolean = workspaceRegistered

    companion object {
        @JvmStatic
        fun getInstance(project: Project): BridgeProjectService =
            project.getService(BridgeProjectService::class.java)
    }
}
