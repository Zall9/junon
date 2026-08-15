package com.idebridge.jetbrains.document

import com.idebridge.jetbrains.protocol.DocumentContent
import com.idebridge.jetbrains.protocol.DocumentReference
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Revision
import com.idebridge.jetbrains.protocol.Workspace
import com.idebridge.jetbrains.protocol.WorkspaceRoot
import com.idebridge.jetbrains.workspace.WorkspaceUri
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Builds document references and revisions.
 *
 * `contentHash` is the authoritative identity of a document's content (ADR-0002, ADR-0020).
 * `editorVersion` accompanies it only when the content came from an editor buffer; content read
 * from disk has no editor version and says so by omission rather than by a placeholder.
 */
public class DocumentModel(private val versions: EditorVersionRegistry = EditorVersionRegistry()) {

    public sealed interface Source {
        /** Content held in an in-memory buffer, which may differ from what is on disk. */
        public data class Buffer(val text: String, val isDirty: Boolean) : Source

        /** Content read from disk, with no editor buffer behind it. */
        public data class Disk(val text: String) : Source
    }

    public sealed interface Outcome {
        public data class Ready(val content: DocumentContent) : Outcome

        public enum class Refusal { OUTSIDE_WORKSPACE, NO_MATCHING_ROOT }

        public data class Refused(val reason: Refusal) : Outcome
    }

    public fun read(
        workspace: Workspace,
        uri: String,
        source: Source,
        languageId: String? = null,
    ): Outcome {
        val root = workspace.roots.firstOrNull { WorkspaceUri.isWithinRoot(uri, it.uri) }
            ?: return Outcome.Refused(Outcome.Refusal.OUTSIDE_WORKSPACE)
        val logicalPath = relativePath(root, uri)
            ?: return Outcome.Refused(Outcome.Refusal.NO_MATCHING_ROOT)

        val text = when (source) {
            is Source.Buffer -> source.text
            is Source.Disk -> source.text
        }
        val revision = Revision(
            // A buffer carries a version; disk content does not exist in any editor and must not
            // claim one (ADR-0020).
            editorVersion = when (source) {
                is Source.Buffer -> versions.current(uri)
                is Source.Disk -> null
            },
            contentHash = hash(text),
            workspaceEpoch = workspace.workspaceEpoch,
        )
        return Outcome.Ready(
            DocumentContent(
                document = DocumentReference(
                    workspaceId = workspace.workspaceId,
                    rootId = root.rootId,
                    uri = uri,
                    logicalPath = logicalPath,
                    revision = revision,
                    positionEncoding = PositionEncoding.UTF16,
                    languageId = languageId,
                    // Disk content is by definition what was last saved.
                    isDirty = source is Source.Buffer && source.isDirty,
                ),
                text = text,
            ),
        )
    }

    /** Path of `uri` relative to its root, used for display and never for filesystem access. */
    private fun relativePath(root: WorkspaceRoot, uri: String): String? {
        val prefix = root.uri.trimEnd('/')
        if (!uri.startsWith(prefix)) return null
        return uri.removePrefix(prefix).trimStart('/').ifEmpty { null }
    }

    public companion object {
        public fun hash(text: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            return "sha256:" + digest.joinToString("") { "%02x".format(it) }
        }
    }
}

/**
 * Per-document editor versions.
 *
 * ADR-0002 prescribes an adapter-maintained counter for JetBrains, which has no equivalent of a
 * simple document version. The platform's own modification stamp is a large, non-monotonic long
 * unsuited to the protocol's `integer` field, so the plugin counts changes itself.
 *
 * Counters reset when the plugin restarts. That is safe because handles and plans are bound to a
 * session and an epoch, and because `contentHash` — not the version — is what a precondition
 * actually rests on.
 */
public class EditorVersionRegistry {
    private val versions = ConcurrentHashMap<String, AtomicInteger>()

    public fun current(uri: String): Int = versions.computeIfAbsent(uri) { AtomicInteger(0) }.get()

    /** Called on every in-memory change to a document. */
    public fun recordChange(uri: String): Int =
        versions.computeIfAbsent(uri) { AtomicInteger(0) }.incrementAndGet()

    public fun forget(uri: String) {
        versions.remove(uri)
    }

    public fun clear() {
        versions.clear()
    }
}
