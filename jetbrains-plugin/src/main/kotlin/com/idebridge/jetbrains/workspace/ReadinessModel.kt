package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.protocol.ReadinessProgress
import com.idebridge.jetbrains.protocol.ReadinessState
import com.idebridge.jetbrains.protocol.WorkspaceId
import com.idebridge.jetbrains.protocol.WorkspaceStatus

/**
 * Maps JetBrains index state to IDEBP readiness.
 *
 * This is the first adapter where readiness is observable rather than assumed. VS Code exposes no
 * index-readiness signal, so its adapter never reports `indexing` and never emits `INDEX_NOT_READY`
 * (ADR-0019). JetBrains has dumb mode, so both become truthful here.
 *
 * While the IDE is in dumb mode, index-dependent operations are genuinely unavailable and are
 * reported as such. They are named in `capabilitiesUnavailable` rather than being answered with
 * empty or partial results, which would look like "no matches" instead of "cannot answer yet".
 */
public object ReadinessModel {
    /**
     * Operations that cannot be answered without indexes.
     *
     * Document reads and revisions are absent on purpose: they only need the document, so they
     * remain available in dumb mode and must not be reported as unavailable.
     */
    public val INDEX_DEPENDENT_METHODS: List<String> = listOf(
        "workspace/searchSymbols",
        "workspace/searchTodos",
        "workspace/listBookmarks",
        "symbol/resolveAt",
        "symbol/getDefinition",
        "symbol/getReferences",
        "symbol/getImplementations",
        "symbol/getHierarchy",
        "document/getSymbols",
        "diagnostics/getSnapshot",
        "refactor/prepare",
        "refactor/prepareRename",
        "workspace/applyPlan",
        "workspace/discardPlan",
        "workspace/undo",
    )

    /**
     * Everything this adapter serves.
     *
     * An IDE that cannot run a read action cannot answer *any* of these — not even a document read,
     * which needs no index. Listing only the index-dependent ones would understate a blockage.
     */
    public val ALL_SERVED_METHODS: List<String> =
        INDEX_DEPENDENT_METHODS + listOf("document/read", "document/getRevision")

    public enum class IndexState {
        /** The project is opening; indexes are not yet usable. */
        INITIALIZING,

        /** Dumb mode: indexes are being built or rebuilt. */
        DUMB,

        /** Smart mode: indexes are usable. */
        SMART,

        /**
         * The IDE is not answering at all.
         *
         * Indexes may be perfectly usable; what has stopped is the IDE's ability to run the read
         * actions every route needs — most often because it is waiting on a modal dialog nobody is
         * there to answer. Measured on 2026-08-14: `workspace/getStatus` answered `ready` in 0.00 s
         * while three routes failed at exactly the 30 s route timeout, because readiness is pushed
         * by this adapter and nothing was pushing it. `ready` then means "the last thing I said",
         * not "I can answer", and a consumer polling it waits for ever.
         */
        BLOCKED,

        /** The plugin is not connected to a daemon. */
        DISCONNECTED,
    }

    public fun status(workspaceId: WorkspaceId, state: IndexState): WorkspaceStatus =
        WorkspaceStatus(
            workspaceId = workspaceId,
            state = when (state) {
                IndexState.INITIALIZING -> ReadinessState.INITIALIZING
                IndexState.DUMB -> ReadinessState.INDEXING
                IndexState.SMART -> ReadinessState.READY
                IndexState.BLOCKED -> ReadinessState.DEGRADED
                IndexState.DISCONNECTED -> ReadinessState.DISCONNECTED
            },
            capabilitiesUnavailable = when (state) {
                IndexState.SMART -> emptyList()
                IndexState.BLOCKED -> ALL_SERVED_METHODS
                else -> INDEX_DEPENDENT_METHODS
            },
            // The platform reports dumb-mode progress as an indeterminate indicator far more often
            // than a percentage, so no percentage is claimed rather than one being invented.
            progress = ReadinessProgress(known = false),
        )

    /** True when the method cannot be answered in the given state. */
    public fun isBlocked(method: String, state: IndexState): Boolean = when (state) {
        IndexState.SMART -> false
        IndexState.BLOCKED -> method in ALL_SERVED_METHODS
        else -> method in INDEX_DEPENDENT_METHODS
    }
}
