package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.AdapterId
import com.idebridge.jetbrains.protocol.SessionId
import com.idebridge.jetbrains.protocol.Symbol
import com.idebridge.jetbrains.protocol.SymbolHandle
import com.idebridge.jetbrains.protocol.SymbolHandleId
import com.idebridge.jetbrains.protocol.SymbolLocator
import com.idebridge.jetbrains.protocol.WorkspaceId
import com.idebridge.jetbrains.workspace.WorkspaceModel
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Opaque, session-bound symbol handles.
 *
 * Generic over the anchor so the bookkeeping is testable without the platform; the JetBrains
 * adapter supplies a `SmartPsiElementPointer`, which is what makes a handle resolvable in O(1)
 * after the PSI tree has been rebuilt.
 *
 * Two namespaces, for the reason ADR-0017 established: a document's symbol tree is replaced
 * atomically when recomputed, while individual results — search hits, point resolutions — live in
 * bounded FIFO generations. Producing one must never revoke handles a document already handed out.
 *
 * Access is synchronized: handles are minted on background threads and invalidated from PSI change
 * listeners, so the two must not interleave.
 */
public class SymbolHandleRegistry<A>(private val maxHandles: Int = DEFAULT_MAX_HANDLES) {

    public data class Draft<A>(
        val locator: SymbolLocator,
        val range: com.idebridge.jetbrains.protocol.Range,
        val anchor: A,
        val children: List<Draft<A>> = emptyList(),
    )

    public data class Resolved<A>(
        val kind: Kind,
        val documentUri: String,
        val editorVersion: Int?,
        val locator: SymbolLocator,
        val anchor: A,
    )

    public enum class Kind { DOCUMENT, TRANSIENT }

    public data class Context(
        val adapterId: AdapterId,
        val sessionId: SessionId,
        val workspaceId: WorkspaceId,
        val workspaceEpoch: Int,
        val editorVersion: Int? = null,
    )

    private data class Record<A>(
        val kind: Kind,
        val workspaceId: WorkspaceId,
        val documentUri: String,
        val editorVersion: Int?,
        val locator: SymbolLocator,
        val anchor: A,
    )

    private val lock = ReentrantLock()
    private val records = linkedMapOf<SymbolHandleId, Record<A>>()
    private val documentHandles = linkedMapOf<String, MutableSet<SymbolHandleId>>()
    private val transientGenerations = ArrayDeque<MutableSet<SymbolHandleId>>()
    private val transientByDocument = linkedMapOf<String, MutableSet<SymbolHandleId>>()

    public val size: Int
        get() = lock.withLock { records.size }

    /**
     * Resolves a consumer handle. Returns `null` for any handle this adapter did not mint in this
     * physical session and epoch, or that has since been invalidated — the caller then falls back to
     * controlled relocation rather than guessing (ADR-0018).
     */
    public fun resolve(handle: SymbolHandle, context: Context): Resolved<A>? = lock.withLock {
        if (handle.adapterId != context.adapterId) return null
        if (handle.sessionId != context.sessionId) return null
        if (handle.validUntilEpoch != context.workspaceEpoch) return null
        val record = records[handle.id] ?: return null
        if (record.workspaceId != context.workspaceId) return null
        Resolved(record.kind, record.documentUri, record.editorVersion, record.locator, record.anchor)
    }

    /** Replaces a document's symbol tree atomically. */
    public fun materializeDocument(
        drafts: List<Draft<A>>,
        documentUri: String,
        context: Context,
    ): List<Symbol> = lock.withLock {
        val key = key(context.workspaceId, documentUri)
        val replaced = documentHandles[key]?.size ?: 0
        reserveCapacity(count(drafts) - replaced)

        val staged = linkedMapOf<SymbolHandleId, Record<A>>()
        val symbols = drafts.map { draft ->
            materialize(draft, context, staged) { locator, anchor ->
                Record(Kind.DOCUMENT, context.workspaceId, documentUri, context.editorVersion, locator, anchor)
            }
        }
        invalidateDocumentLocked(context.workspaceId, documentUri)
        val ids = linkedSetOf<SymbolHandleId>()
        for ((id, record) in staged) {
            records[id] = record
            ids.add(id)
        }
        documentHandles[key] = ids
        symbols
    }

    /**
     * Materializes individual results as their own generation. These never replace a document's
     * handles: a search touching a document already explored must not revoke what it handed out.
     */
    public fun materializeTransient(drafts: List<Draft<A>>, context: Context): List<Symbol> =
        lock.withLock {
            reserveCapacity(drafts.size)
            val staged = linkedMapOf<SymbolHandleId, Record<A>>()
            val symbols = drafts.map { draft ->
                materialize(draft.copy(children = emptyList()), context, staged) { locator, anchor ->
                    Record(
                        Kind.TRANSIENT,
                        context.workspaceId,
                        locator.documentUri,
                        context.editorVersion,
                        locator,
                        anchor,
                    )
                }
            }
            val generation = linkedSetOf<SymbolHandleId>()
            for ((id, record) in staged) {
                records[id] = record
                generation.add(id)
                transientByDocument
                    .getOrPut(key(record.workspaceId, record.documentUri)) { linkedSetOf() }
                    .add(id)
            }
            transientGenerations.addLast(generation)
            while (transientGenerations.size > MAX_TRANSIENT_GENERATIONS) evictOldestTransient()
            symbols
        }

    /** Revokes every handle for a document, in both namespaces. */
    public fun invalidateDocument(workspaceId: WorkspaceId, documentUri: String): Unit =
        lock.withLock { invalidateDocumentLocked(workspaceId, documentUri) }

    public fun invalidateAll(): Unit = lock.withLock {
        records.clear()
        documentHandles.clear()
        transientGenerations.clear()
        transientByDocument.clear()
    }

    private fun invalidateDocumentLocked(workspaceId: WorkspaceId, documentUri: String) {
        val key = key(workspaceId, documentUri)
        documentHandles.remove(key)?.forEach { records.remove(it) }
        transientByDocument.remove(key)?.forEach { id ->
            records.remove(id)
            transientGenerations.forEach { it.remove(id) }
        }
    }

    /**
     * Frees room by evicting transient generations oldest-first, never document handles: a
     * long-lived registry must not fail a document request because of accumulated search history.
     */
    private fun reserveCapacity(additional: Int) {
        while (records.size + additional > maxHandles && transientGenerations.isNotEmpty()) {
            evictOldestTransient()
        }
        require(records.size + additional <= maxHandles) { "Symbol handle capacity exceeded" }
    }

    private fun evictOldestTransient() {
        val oldest = transientGenerations.removeFirstOrNull() ?: return
        for (id in oldest) {
            val record = records.remove(id) ?: continue
            val key = key(record.workspaceId, record.documentUri)
            transientByDocument[key]?.let { byDocument ->
                byDocument.remove(id)
                if (byDocument.isEmpty()) transientByDocument.remove(key)
            }
        }
    }

    private fun materialize(
        draft: Draft<A>,
        context: Context,
        staged: MutableMap<SymbolHandleId, Record<A>>,
        record: (SymbolLocator, A) -> Record<A>,
    ): Symbol {
        val id = createHandleId(staged)
        staged[id] = record(draft.locator, draft.anchor)
        return Symbol(
            handle = SymbolHandle(
                adapterId = context.adapterId,
                sessionId = context.sessionId,
                id = id,
                validUntilEpoch = context.workspaceEpoch,
            ),
            locator = draft.locator,
            range = draft.range,
            children = draft.children.map { materialize(it, context, staged, record) },
        )
    }

    private fun createHandleId(staged: Map<SymbolHandleId, Record<A>>): SymbolHandleId {
        repeat(16) {
            val id = WorkspaceModel.createIdentifier("sym_")
            if (id !in records && id !in staged) return id
        }
        error("Could not allocate a unique symbol handle")
    }

    private fun count(drafts: List<Draft<A>>): Int =
        drafts.sumOf { 1 + count(it.children) }

    private fun key(workspaceId: WorkspaceId, documentUri: String): String =
        "$workspaceId $documentUri"

    public companion object {
        public const val DEFAULT_MAX_HANDLES: Int = 20_000
        public const val MAX_TRANSIENT_GENERATIONS: Int = 5
    }
}
