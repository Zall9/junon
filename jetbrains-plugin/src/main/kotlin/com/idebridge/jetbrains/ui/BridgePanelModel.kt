package com.idebridge.jetbrains.ui

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService.Outcome.Refusal

/**
 * What the tool window says, decided without Swing.
 *
 * The panel used to be one project's labels and one button, and its wording lived inside the
 * repaint. A row per open project multiplies every one of those decisions — which project is named
 * first, what an in-flight link reads as, when an action is worth offering — so they are made here,
 * against facts, and the panel only draws the answer.
 *
 * Nothing in this file imports Swing or the platform: a test can state that a refused project says
 * why without opening a window.
 */
object BridgePanelModel {

    /** An operation the panel has started and not yet heard back from. */
    enum class Pending { LINKING, UNLINKING }

    /** One project, as the panel knows it at the moment of a repaint. */
    data class Facts(
        val name: String,
        /** The project this panel belongs to, which is named as such rather than left to guess. */
        val isPanelProject: Boolean,
        /** The workspace it is serving, or `null` when it is not linked. */
        val workspaceId: String?,
        val pending: Pending? = null,
        /** Why the last attempt was refused, so the row can say it instead of looking inert. */
        val refusal: Refusal? = null,
    )

    /** One row, as text and one enabled flag. */
    data class Row(
        val title: String,
        val state: String,
        val action: String,
        val actionEnabled: Boolean,
    )

    /**
     * The order rows appear in: this panel's own project first, the rest by name.
     *
     * Decided rather than inherited. `ProjectManager.openProjects` is in the order the projects
     * opened, so a panel that echoed it would reshuffle its own rows as other windows come and go,
     * and the project a reader is sitting in front of could be anywhere in the list.
     */
    @JvmField
    val ORDER: Comparator<Facts> = compareBy<Facts> { !it.isPanelProject }.thenBy { it.name }

    fun daemonLine(available: Boolean): String = if (available) {
        "Daemon: reachable"
    } else {
        "Daemon: none found — start one with `ide-bridge daemon`"
    }

    fun row(facts: Facts, daemonAvailable: Boolean): Row {
        val linked = facts.workspaceId != null
        return Row(
            title = if (facts.isPanelProject) "${facts.name} (this project)" else facts.name,
            state = state(facts),
            action = when (facts.pending) {
                Pending.LINKING -> "Linking…"
                Pending.UNLINKING -> "Unlinking…"
                null -> if (linked) "Unlink" else "Link"
            },
            // Two reasons an action is not offered, and they are different: something is already in
            // flight for this project, or there is no daemon for a link to reach. Linking is left
            // clickable while linked, because unlinking never needs one.
            actionEnabled = facts.pending == null && (linked || daemonAvailable),
        )
    }

    /**
     * Why a refusal happened, in words.
     *
     * A `Refused` outcome carries a typed reason precisely so this is possible; a click that
     * silently did nothing is what ADR-0033 set out to remove.
     */
    fun explain(reason: Refusal): String = when (reason) {
        Refusal.NO_DAEMON -> "no daemon is running"
        Refusal.NO_CONTENT_ROOT -> "this project publishes no content root yet"
        Refusal.UNREACHABLE -> "the daemon refused the connection"
        Refusal.HANDSHAKE_REFUSED -> "the daemon refused the handshake"
        Refusal.REGISTRATION_REFUSED -> "the daemon refused the registration"
    }

    private fun state(facts: Facts): String = when {
        facts.pending == Pending.LINKING -> "linking…"
        facts.pending == Pending.UNLINKING -> "unlinking…"
        facts.workspaceId != null -> "linked as ${facts.workspaceId}"
        facts.refusal != null -> "not linked — ${explain(facts.refusal)}"
        else -> "not linked"
    }
}
