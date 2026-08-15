package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotParams
import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotResult
import com.idebridge.jetbrains.protocol.DocumentContent
import com.idebridge.jetbrains.protocol.DocumentGetRevisionResult
import com.idebridge.jetbrains.protocol.DocumentGetSymbolsResult
import com.idebridge.jetbrains.protocol.DocumentTargetParams
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.ModificationResult
import com.idebridge.jetbrains.protocol.RefactorPrepareParams
import com.idebridge.jetbrains.protocol.SymbolHierarchyParams
import com.idebridge.jetbrains.protocol.SymbolLocationsResult
import com.idebridge.jetbrains.protocol.SymbolResolveAtParams
import com.idebridge.jetbrains.protocol.SymbolResolveAtResult
import com.idebridge.jetbrains.protocol.SymbolTargetParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameResult
import com.idebridge.jetbrains.protocol.Request
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsResult
import com.idebridge.jetbrains.protocol.WorkspaceListBookmarksParams
import com.idebridge.jetbrains.protocol.WorkspaceListBookmarksResult
import com.idebridge.jetbrains.protocol.WorkspaceSearchTodosParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchTodosResult
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanResult
import com.idebridge.jetbrains.protocol.WorkspaceUndoParams
import kotlinx.serialization.KSerializer

/**
 * Routes a daemon-forwarded request to the adapter's implementation.
 *
 * Free of platform types: the [Backend] is what touches the IDE, so the routing, the decoding and
 * the refusals are exercised without one.
 *
 * Only methods the adapter genuinely implements are routed. Anything else falls through to
 * [RpcClient.Answer.Unsupported], which answers `CAPABILITY_UNAVAILABLE` — the same thing the
 * registration declares, so what the adapter advertises and what it does cannot drift apart.
 */
public class AdapterRouter(private val backend: Backend) : RpcClient.RequestHandler {

    /**
     * What the adapter can actually answer.
     *
     * `null` means the target is not this adapter's to answer for, which becomes a not-found rather
     * than an empty result — a consumer must be able to tell "no such document" from "this document
     * has nothing".
     */
    public interface Backend {
        public fun documentSymbols(workspaceId: String, uri: String): SymbolsOutcome?

        /** The document's content and revision together, as `document/read` returns them. */
        /**
         * Workspace-wide symbol search. `null` when the workspace is not this one.
         *
         * An outcome rather than a result, for the same reason [hierarchy] has one: while the IDE is
         * indexing, the name index cannot answer, and an empty list would read as "no such symbol"
         * and be believed.
         */
        public fun searchSymbols(params: WorkspaceSearchSymbolsParams): SearchOutcome?

        public fun documentRead(workspaceId: String, uri: String): DocumentContent?

        public fun documentRevision(workspaceId: String, uri: String): DocumentGetRevisionResult?

        public fun diagnostics(
            workspaceId: String,
            documentUris: List<String>?,
        ): DiagnosticsOutcome?

        public fun prepareRename(params: RefactorPrepareRenameParams): RenameOutcome?

        /** Any operation in the plan vocabulary, not only rename. */
        /** Navigation from a symbol reference. `null` when the workspace is not this one. */
        public fun locations(
            method: String,
            params: SymbolTargetParams,
        ): SymbolLocationsResult?

        /** One step of a call or type hierarchy. `null` when the workspace is not this one. */
        public fun hierarchy(params: SymbolHierarchyParams): HierarchyOutcome?

        /** The IDE's own TODO markers. `null` when the workspace is not this one. */
        public fun searchTodos(params: WorkspaceSearchTodosParams): WorkspaceSearchTodosResult?

        /** The user's own bookmarks. `null` when the workspace is not this one. */
        public fun listBookmarks(
            params: WorkspaceListBookmarksParams,
        ): WorkspaceListBookmarksResult?

        public fun resolveAt(params: SymbolResolveAtParams): SymbolResolveAtResult?

        public fun prepare(params: RefactorPrepareParams): RenameOutcome?

        public fun applyPlan(params: WorkspaceApplyPlanParams): ApplyOutcome?

        public fun discardPlan(params: WorkspaceDiscardPlanParams): WorkspaceDiscardPlanResult?

        public fun undo(params: WorkspaceUndoParams): ApplyOutcome?
    }

    /** An edit refuses with a protocol code, which is what a consumer can act on. */
    public sealed interface RenameOutcome {
        public data class Prepared(val result: RefactorPrepareRenameResult) : RenameOutcome

        public data class Refused(val code: ErrorCode) : RenameOutcome
    }

    public sealed interface ApplyOutcome {
        public data class Applied(val result: ModificationResult) : ApplyOutcome

        public data class Refused(val code: ErrorCode) : ApplyOutcome
    }

    /**
     * A hierarchy step either answers or says the relation has no engine behind it.
     *
     * The distinction is the point: an unsupported relation returned as an empty list reads as
     * "nothing found" and would be believed, which is the approximation this project refuses.
     */
    public sealed interface HierarchyOutcome {
        public data class Found(val result: SymbolLocationsResult) : HierarchyOutcome

        public data object Unsupported : HierarchyOutcome
    }

    /** What a symbol search produced, or why it could not (ADR-0034). */
    public sealed interface SearchOutcome {
        public data class Found(val result: WorkspaceSearchSymbolsResult) : SearchOutcome

        /**
         * The IDE is still building the index this route reads.
         *
         * Refused rather than answered empty, and with a retriable code: a consumer that received
         * `[]` here would conclude the symbol does not exist, which is the one thing that is
         * certainly not known yet.
         */
        public data object IndexNotReady : SearchOutcome
    }

    /** What `document/getSymbols` can answer. */
    public sealed interface SymbolsOutcome {

        public data class Ready(val result: DocumentGetSymbolsResult) : SymbolsOutcome

        /**
         * No language plugin in this IDE claims the file, so it has no declarations to report.
         *
         * Measured with IntelliJ IDEA Community — which ships no JavaScript support — on a
         * TypeScript file: an empty symbol list, indistinguishable from a file that declares
         * nothing. PhpStorm answered thirteen symbols for the same file, which is what makes the
         * empty answer a statement about the IDE rather than about the code.
         *
         * A language with a parser but no structure view is not this case; the PSI walk finds its
         * declarations, which is what that fallback is for.
         */
        public data object LanguageUnsupported : SymbolsOutcome
    }

    /** What `diagnostics/getSnapshot` can answer. */
    public sealed interface DiagnosticsOutcome {

        public data class Ready(val result: DiagnosticsGetSnapshotResult) : DiagnosticsOutcome

        /**
         * The IDE cannot analyse this workspace at all, and waiting will not change that.
         *
         * Distinct from an analysis that has not finished, which is a real snapshot flagged
         * incomplete. A project opened with no source roots — no module, no SDK — produces neither
         * problems nor a completion, so a consumer polling for one waits for ever. Measured against
         * a real IntelliJ on an unconfigured Java project: eight requests over thirty-two seconds,
         * each answering zero diagnostics with `truncated = true`, indistinguishable from a file
         * still being looked at.
         *
         * Answered as a refusal rather than an empty success for the reason ADR-0034 gives about
         * the index: a route that cannot answer has to say so.
         */
        public data object NotAnalysable : DiagnosticsOutcome
    }

    override fun handle(method: String, raw: String): RpcClient.Answer = when (method) {
        "workspace/searchSymbols" -> route(raw, WorkspaceSearchSymbolsParams.serializer()) { params ->
            when (val outcome = backend.searchSymbols(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                // Retriable by contract: the index will exist shortly, and saying so is what stops a
                // consumer from recording "no such symbol" as a fact.
                is SearchOutcome.IndexNotReady ->
                    RpcClient.Answer.Failed(ErrorCode.INDEX_NOT_READY)

                is SearchOutcome.Found ->
                    encode(WorkspaceSearchSymbolsResult.serializer(), outcome.result)
            }
        }

        "document/read" -> route(raw, DocumentTargetParams.serializer()) { params ->
            backend.documentRead(params.workspaceId, params.uri)
                ?.let { encode(DocumentContent.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.DOCUMENT_NOT_FOUND)
        }

        "document/getRevision" -> route(raw, DocumentTargetParams.serializer()) { params ->
            backend.documentRevision(params.workspaceId, params.uri)
                ?.let { encode(DocumentGetRevisionResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.DOCUMENT_NOT_FOUND)
        }

        "document/getSymbols" -> route(raw, DocumentTargetParams.serializer()) { params ->
            when (val outcome = backend.documentSymbols(params.workspaceId, params.uri)) {
                null -> RpcClient.Answer.Failed(ErrorCode.DOCUMENT_NOT_FOUND)
                // Not retriable: no amount of waiting teaches this IDE a language it does not ship.
                // A consumer is meant to ask a different IDE, not to ask again.
                is SymbolsOutcome.LanguageUnsupported ->
                    RpcClient.Answer.Failed(ErrorCode.CAPABILITY_UNAVAILABLE)

                is SymbolsOutcome.Ready ->
                    encode(DocumentGetSymbolsResult.serializer(), outcome.result)
            }
        }

        "diagnostics/getSnapshot" -> route(raw, DiagnosticsGetSnapshotParams.serializer()) { params ->
            when (val outcome = backend.diagnostics(params.workspaceId, params.documentUris)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                // Not retriable, and that is the whole point: `INDEX_NOT_READY` would tell a
                // consumer to wait for something that is never coming.
                is DiagnosticsOutcome.NotAnalysable ->
                    RpcClient.Answer.Failed(ErrorCode.CAPABILITY_UNAVAILABLE)

                is DiagnosticsOutcome.Ready ->
                    encode(DiagnosticsGetSnapshotResult.serializer(), outcome.result)
            }
        }

        "symbol/getDefinition",
        "symbol/getReferences",
        "symbol/getImplementations",
        -> route(raw, SymbolTargetParams.serializer()) { params ->
            backend.locations(method, params)
                ?.let { encode(SymbolLocationsResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
        }

        "symbol/getHierarchy" -> route(raw, SymbolHierarchyParams.serializer()) { params ->
            when (val outcome = backend.hierarchy(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                // A relation with no language-neutral engine behind it is refused by name. The
                // alternative — an empty result — would read as "nothing found" and be believed.
                is HierarchyOutcome.Unsupported ->
                    RpcClient.Answer.Failed(ErrorCode.CAPABILITY_UNAVAILABLE)

                is HierarchyOutcome.Found ->
                    encode(SymbolLocationsResult.serializer(), outcome.result)
            }
        }

        "workspace/searchTodos" -> route(raw, WorkspaceSearchTodosParams.serializer()) { params ->
            backend.searchTodos(params)
                ?.let { encode(WorkspaceSearchTodosResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
        }

        "workspace/listBookmarks" -> route(raw, WorkspaceListBookmarksParams.serializer()) { params ->
            backend.listBookmarks(params)
                ?.let { encode(WorkspaceListBookmarksResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
        }

        "symbol/resolveAt" -> route(raw, SymbolResolveAtParams.serializer()) { params ->
            backend.resolveAt(params)
                ?.let { encode(SymbolResolveAtResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.DOCUMENT_NOT_FOUND)
        }

        "refactor/prepare" -> route(raw, RefactorPrepareParams.serializer()) { params ->
            when (val outcome = backend.prepare(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                is RenameOutcome.Refused -> RpcClient.Answer.Failed(outcome.code)
                is RenameOutcome.Prepared ->
                    encode(RefactorPrepareRenameResult.serializer(), outcome.result)
            }
        }

        "refactor/prepareRename" -> route(raw, RefactorPrepareRenameParams.serializer()) { params ->
            when (val outcome = backend.prepareRename(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                is RenameOutcome.Refused -> RpcClient.Answer.Failed(outcome.code)
                is RenameOutcome.Prepared ->
                    encode(RefactorPrepareRenameResult.serializer(), outcome.result)
            }
        }

        "workspace/applyPlan" -> route(raw, WorkspaceApplyPlanParams.serializer()) { params ->
            when (val outcome = backend.applyPlan(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                is ApplyOutcome.Refused -> RpcClient.Answer.Failed(outcome.code)
                is ApplyOutcome.Applied -> encode(ModificationResult.serializer(), outcome.result)
            }
        }

        "workspace/undo" -> route(raw, WorkspaceUndoParams.serializer()) { params ->
            when (val outcome = backend.undo(params)) {
                null -> RpcClient.Answer.Failed(ErrorCode.WORKSPACE_NOT_FOUND)
                is ApplyOutcome.Refused -> RpcClient.Answer.Failed(outcome.code)
                is ApplyOutcome.Applied -> encode(ModificationResult.serializer(), outcome.result)
            }
        }

        "workspace/discardPlan" -> route(raw, WorkspaceDiscardPlanParams.serializer()) { params ->
            backend.discardPlan(params)
                ?.let { encode(WorkspaceDiscardPlanResult.serializer(), it) }
                ?: RpcClient.Answer.Failed(ErrorCode.PLAN_NOT_FOUND)
        }

        else -> RpcClient.Answer.Unsupported
    }

    /**
     * Decodes, then delegates.
     *
     * A backend that throws answers `PROVIDER_FAILED` rather than propagating: the session-level
     * handler would report it as `INTERNAL_ERROR`, which says the adapter is broken when in fact
     * one provider is.
     */
    private fun <P> route(
        raw: String,
        serializer: KSerializer<P>,
        answer: (P) -> RpcClient.Answer,
    ): RpcClient.Answer {
        val params = runCatching {
            IdebpJson.decodeFromString(Request.serializer(serializer), raw).params
        }.getOrNull() ?: return RpcClient.Answer.Failed(ErrorCode.INVALID_REQUEST)

        return runCatching { answer(params) }
            .getOrElse { failure ->
                // Logged, not discarded. The wire answer stays `PROVIDER_FAILED` — an exception's
                // message can carry file text and must not travel — but the IDE's own log is where
                // an adapter author can see what actually broke. Swallowing it here is the same
                // defect the daemon's refusal sweep removed: a refusal nobody can act on.
                com.intellij.openapi.diagnostic.logger<AdapterRouter>()
                    .warn("[IDE Bridge] routed request failed", failure)
                RpcClient.Answer.Failed(ErrorCode.PROVIDER_FAILED)
            }
    }

    private fun <R> encode(serializer: KSerializer<R>, value: R): RpcClient.Answer =
        RpcClient.Answer.Result(IdebpJson.encodeToJsonElement(serializer, value))

    public companion object {
        /** The methods this router serves; the registration announces exactly these as supported. */
        public val IMPLEMENTED_METHODS: Set<String> = setOf(
            "workspace/searchSymbols",
            "workspace/searchTodos",
            "workspace/listBookmarks",
            "document/read",
            "document/getRevision",
            "document/getSymbols",
            "symbol/resolveAt",
            "symbol/getDefinition",
            "symbol/getReferences",
            "symbol/getImplementations",
            "symbol/getHierarchy",
            "diagnostics/getSnapshot",
            "refactor/prepare",
            "refactor/prepareRename",
            "workspace/applyPlan",
            "workspace/discardPlan",
            "workspace/undo",
        )
    }
}
