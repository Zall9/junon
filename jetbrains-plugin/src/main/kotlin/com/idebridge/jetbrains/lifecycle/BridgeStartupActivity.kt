package com.idebridge.jetbrains.lifecycle

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService
import com.idebridge.jetbrains.service.ReadinessManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Runs once per project, after it has opened.
 *
 * This replaces two hooks the Plugin Verifier rejects: `AppLifecycleListener.appStarted`, which is
 * `@ApiStatus.Internal`, and `ProjectManagerListener.projectOpened`, which is deprecated for
 * removal. `ProjectActivity` is the platform's supported equivalent and is the only one of the
 * three that is public API.
 *
 * It also runs off the EDT by construction, so the explicit pooled-thread hop the old listener
 * needed to honour "no blocking work on the dispatch thread" (AGENTS.md §3) is no longer required.
 * Connecting is idempotent, so running per project rather than once per application is safe.
 */
class BridgeStartupActivity : ProjectActivity {

    private val logger = logger<BridgeStartupActivity>()

    /**
     * Links the project that opened, and says what came of it.
     *
     * Each project has its own link now, so this no longer depends on being the first project of the
     * session — which is what it silently was (ADR-0033). A refusal is logged with its reason; the
     * tool window is where it can be seen and reversed.
     */
    override suspend fun execute(project: Project) {
        logger.info("[IDE Bridge] Project opened: ${project.name}")
        ReadinessManager.getInstance().setState(ReadinessManager.ReadinessState.INITIALIZING)
        val outcome = BridgeDaemonConnectionService.getInstance().link(project)
        if (outcome is BridgeDaemonConnectionService.Outcome.Refused) {
            logger.info("[IDE Bridge] ${project.name} not linked: ${outcome.reason}")
        }
        // Announced whatever the outcome: every already-open project's panel offers a row per open
        // project, and a project that opened and was refused a link still belongs in that list.
        OpenProjectsListener.announce()
    }
}
