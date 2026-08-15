package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.workspace.ReadinessModel
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager

/**
 * The only place that reads live IntelliJ state.
 *
 * Everything above this file works on [WorkspaceModel.ProjectSnapshot] and
 * [ReadinessModel.IndexState], so the mapping rules are tested without the platform and this layer
 * stays small enough to review by eye. No IntelliJ object crosses the wire (AGENTS.md §3).
 *
 * Content roots are read inside a read action: the project model may be mutated from another
 * thread, and reading it without one is a race the platform explicitly forbids.
 */
public object IntelliJProjectSnapshot {
    /**
     * Captures the project's current state.
     *
     * Must not be called on the EDT with a project that is still opening; callers schedule it off
     * the dispatch thread (AGENTS.md §3).
     */
    public fun capture(project: Project): WorkspaceModel.ProjectSnapshot {
        val rootUris = ReadAction.compute<List<String>, RuntimeException> {
            ProjectRootManager.getInstance(project)
                .contentRoots
                // `url` is already a VFS URI; it is passed through unchanged rather than converted
                // to a local path, which the protocol forbids (AGENTS.md §2).
                .map { it.url }
                .distinct()
        }
        return Snapshot(
            name = project.name,
            rootUris = rootUris,
            trust = trustState(project),
        )
    }

    /**
     * IntelliJ tracks trust as a three-state value, but every `getProjectTrustedState` overload is
     * marked `@ApiStatus.Internal`; the only public reader is a boolean. The public one is used,
     * which costs the [WorkspaceModel.TrustState.UNDECIDED] distinction on this adapter: a project
     * whose trust has not been decided reports as denied.
     *
     * That is a loss of fidelity, not of safety — the daemon permits writes only on `trusted`, so
     * an undecided project is refused either way. The protocol keeps `unknown` because it remains
     * the honest answer for an adapter that can observe it; this one currently cannot without
     * depending on API the platform reserves the right to remove.
     */
    public fun trustState(project: Project): WorkspaceModel.TrustState =
        if (TrustedProjects.isProjectTrusted(project)) {
            WorkspaceModel.TrustState.GRANTED
        } else {
            WorkspaceModel.TrustState.DENIED
        }

    /**
     * Whether the project has any source root for the index to have filled.
     *
     * A project can be open, trusted, fully indexed and still answer a symbol search with nothing,
     * because its files sit in a content root that no module marks as **sources** — an unfinished
     * Gradle import, or a plain directory nobody marked. Measured in a real IDE on 2026-08-10: the
     * IDE's own Go-to-Symbol dialog found nothing there either, so the adapter was agreeing with the
     * IDE rather than failing, and the empty answer was true and useless at once. Distinguishing that
     * from "no such symbol" is what this exists for (ADR-0034).
     */
    public fun hasSourceRoots(project: Project): Boolean =
        ReadAction.compute<Boolean, RuntimeException> {
            ProjectRootManager.getInstance(project).contentSourceRoots.isNotEmpty()
        }

    /** Dumb mode is what makes `indexing` and `INDEX_NOT_READY` truthful on this adapter. */
    public fun indexState(project: Project): ReadinessModel.IndexState =
        when {
            !project.isInitialized -> ReadinessModel.IndexState.INITIALIZING
            DumbService.isDumb(project) -> ReadinessModel.IndexState.DUMB
            else -> ReadinessModel.IndexState.SMART
        }

    private data class Snapshot(
        override val name: String,
        override val rootUris: List<String>,
        override val trust: WorkspaceModel.TrustState,
    ) : WorkspaceModel.ProjectSnapshot
}
