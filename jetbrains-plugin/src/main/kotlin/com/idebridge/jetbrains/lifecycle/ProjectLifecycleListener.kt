package com.idebridge.jetbrains.lifecycle

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener

/**
 * Releases a project's state when it closes.
 *
 * The open half moved to [BridgeStartupActivity]: `projectOpened` is deprecated for removal.
 * `projectClosing` is not, and cancelling in-flight work for a closing project (AGENTS.md §3) has
 * no supported alternative, so it stays here.
 */
class ProjectLifecycleListener : ProjectManagerListener {

    private val logger = logger<ProjectLifecycleListener>()

    /**
     * Releases the project's link.
     *
     * This is the half that was missing. The serving thread of a closing project dies on its disposed
     * `Project` and the daemon drops the adapter, but the connection service went on believing it was
     * connected, so no project opened afterwards could link — measured in a real IDE, 2026-08-10
     * (ADR-0033). It also called a Phase 0 skeleton whose `unregisterWorkspace()` only logged, which
     * made the log read as though a workspace had been released.
     */
    override fun projectClosing(project: Project) {
        logger.info("[IDE Bridge] Project closing: ${project.name}")
        BridgeDaemonConnectionService.getInstance().unlink(project)
        // The other windows' panels list this project too, and unlinking alone does not tell them
        // it is going away — a project closing while it was never linked changes no link at all.
        OpenProjectsListener.announce()
    }
}
