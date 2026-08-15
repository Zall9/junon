package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.protocol.AdapterId
import com.idebridge.jetbrains.protocol.RootId
import com.idebridge.jetbrains.protocol.Workspace
import com.idebridge.jetbrains.protocol.WorkspaceId
import com.idebridge.jetbrains.protocol.WorkspaceRoot
import com.idebridge.jetbrains.protocol.WorkspaceTrust
import java.security.SecureRandom
import java.util.Base64

/**
 * Maps an open project to an IDEBP workspace.
 *
 * The IDE's own objects never cross the wire (AGENTS.md §3); this class consumes a [ProjectSnapshot]
 * so the mapping rules are exercised without the platform, and the platform-facing code stays thin.
 *
 * Identity is stable across snapshots: a root keeps its identifier while its URI is unchanged, so a
 * handle minted against it survives an unrelated project change. The epoch advances only when the
 * root set actually changes, or when semantic state is explicitly invalidated on reconnect —
 * bumping it needlessly would revoke every live handle.
 */
public class WorkspaceModel(
    private val adapterId: AdapterId,
    private val workspaceId: WorkspaceId = createIdentifier("ws_"),
    private val createRootId: () -> RootId = { createIdentifier("root_") },
) {
    /** What the model needs from a project. Deliberately no platform types. */
    public interface ProjectSnapshot {
        public val name: String

        /** Content root URIs, in the IDE's own order. */
        public val rootUris: List<String>

        public val trust: TrustState
    }

    /**
     * Mirrors what the platform actually reports. IntelliJ answers trust as a three-state value,
     * so collapsing it to a boolean would discard a distinction the protocol can express: a project
     * whose trust has not been decided is [UNDECIDED], not "untrusted".
     */
    public enum class TrustState {
        GRANTED,
        DENIED,
        UNDECIDED,
    }

    private val rootIds = linkedMapOf<String, RootId>()
    private var epoch = 0
    private var initialized = false

    public val currentEpoch: Int
        get() = epoch

    /** Returns the workspace for this snapshot, or `null` when the project has no content root. */
    public fun snapshot(project: ProjectSnapshot): Workspace? {
        val uris = project.rootUris
        require(uris.size == uris.toSet().size) { "A project cannot expose duplicate content roots" }
        // A root that is not a URI is refused here rather than on the wire. The daemon treats a
        // local path as a policy violation and closes the session, so failing locally turns a lost
        // connection into an error naming the offending root.
        for (uri in uris) {
            require(WorkspaceUri.hasScheme(uri)) { "A content root must be a URI, not a path" }
        }
        if (uris.isEmpty()) {
            synchronizeRoots(uris)
            return null
        }
        synchronizeRoots(uris)
        return Workspace(
            workspaceId = workspaceId,
            adapterId = adapterId,
            name = project.name,
            roots = uris.map { uri ->
                WorkspaceRoot(rootId = rootIds.getValue(uri), name = displayName(uri), uri = uri)
            },
            workspaceEpoch = epoch,
            // Reported as the IDE sees it. Only GRANTED permits writes — the daemon gates on
            // exactly "trusted" — so UNDECIDED still fails closed while staying truthful.
            trust = when (project.trust) {
                TrustState.GRANTED -> WorkspaceTrust.TRUSTED
                TrustState.DENIED -> WorkspaceTrust.UNTRUSTED
                TrustState.UNDECIDED -> WorkspaceTrust.UNKNOWN
            },
        )
    }

    /**
     * Invalidates semantic state, advancing the epoch. Called on reconnect: handles and plans minted
     * in a previous session must not be honoured in a new one.
     */
    public fun invalidateSemanticState(): Int {
        epoch += 1
        return epoch
    }

    private fun synchronizeRoots(uris: List<String>) {
        val changed = rootIds.keys.toList() != uris
        rootIds.keys.retainAll(uris.toSet())
        for (uri in uris) rootIds.getOrPut(uri) { createRootId() }
        // The first snapshot establishes the baseline; it is not a change.
        if (changed && initialized) epoch += 1
        initialized = true
    }

    /** Last non-empty path segment, which is what a user recognises the root by. */
    private fun displayName(uri: String): String =
        uri.trimEnd('/').substringAfterLast('/').ifEmpty { uri }

    public companion object {
        private val random = SecureRandom()

        /** Opaque and unguessable: an identifier must not leak a path or be predictable. */
        public fun createIdentifier(prefix: String): String {
            val bytes = ByteArray(18)
            random.nextBytes(bytes)
            return prefix + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    }
}
