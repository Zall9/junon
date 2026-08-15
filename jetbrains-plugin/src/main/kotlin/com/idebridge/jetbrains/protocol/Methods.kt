package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Request and response payloads for every IDEBP method.
 *
 * Envelopes are generic so the JSON-RPC frame is written once; each method contributes only its
 * params and result. The method catalogue and role partitions below mirror
 * `packages/protocol/src/application-validation.ts`, and `CatalogueCoverageTest` reads the canonical
 * schemas to prove nothing is missing.
 */

@Serializable
public data class Request<P>(
    val jsonrpc: String = "2.0",
    val id: JsonRpcId,
    val method: String,
    val params: P,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
        require(method in APPLICATION_METHODS) { "Unknown IDEBP method: $method" }
    }
}

@Serializable
public data class Response<R>(val jsonrpc: String = "2.0", val id: JsonRpcId, val result: R) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

@Serializable
public enum class IdeKind {
    @SerialName("vscode")
    VSCODE,

    @SerialName("jetbrains")
    JETBRAINS,
}

@Serializable
public data class Adapter(
    val adapterId: AdapterId,
    val sessionId: SessionId,
    val name: String,
    val version: String,
    val ideKind: IdeKind,
    val ideVersion: String,
    val positionEncodings: List<PositionEncoding>,
    val capabilities: Map<String, Capability>,
    val connectedAt: String,
)

@Serializable
public data class Session(
    val sessionId: SessionId,
    val role: SessionRole,
    val protocolVersion: String,
    val clientName: String,
    val connectedAt: String,
    val lastActivityAt: String,
)

@Serializable
public data class IdeRegisterParams(
    val adapterId: AdapterId,
    val name: String,
    val version: String,
    val ideKind: IdeKind,
    val ideVersion: String,
    val positionEncodings: List<PositionEncoding>,
    val capabilities: Map<String, Capability>,
    val workspaces: List<Workspace>,
)

@Serializable
public data class IdeRegisterResult(val adapter: Adapter, val workspaces: List<Workspace>)

@Serializable
public data class IdeUnregisterParams(val adapterId: AdapterId)

@Serializable
public data class IdeUnregisterResult(val adapterId: AdapterId, val unregistered: Boolean)

@Serializable
public data class IdePingParams(val sentAt: String)

@Serializable
public data class IdePingResult(val sentAt: String, val receivedAt: String)

@Serializable
public data class IdeGetCapabilitiesParams(
    val adapterId: AdapterId,
    val workspaceId: WorkspaceId? = null,
)

@Serializable
public data class IdeGetCapabilitiesResult(
    val adapterId: AdapterId,
    val workspaceId: WorkspaceId? = null,
    val capabilities: Map<String, Capability>,
)

// ── Workspaces ───────────────────────────────────────────────────────────────

@Serializable
public data class WorkspaceListParams(val adapterId: AdapterId? = null)

@Serializable
public data class WorkspaceListResult(val workspaces: List<Workspace>)

@Serializable
public data class WorkspaceIdParams(val workspaceId: WorkspaceId)

@Serializable
public data class WorkspaceGetResult(val workspace: Workspace)

@Serializable
public data class WorkspaceGetStatusResult(val status: WorkspaceStatus)

// ── Documents ────────────────────────────────────────────────────────────────

@Serializable
public data class DocumentTargetParams(val workspaceId: WorkspaceId, val uri: String)

@Serializable
public data class DocumentGetRevisionResult(val document: DocumentReference)

@Serializable
public data class DocumentGetSymbolsResult(
    val document: DocumentReference,
    val symbols: List<Symbol>,
)

// ── Symbols ──────────────────────────────────────────────────────────────────

@Serializable
public data class WorkspaceSearchSymbolsParams(
    val workspaceId: WorkspaceId,
    val query: String,
    val kinds: List<SymbolKind>? = null,
    val limit: Int? = null,
)

@Serializable
public data class WorkspaceSearchSymbolsResult(val symbols: List<Symbol>, val truncated: Boolean)

@Serializable
public data class SymbolResolveAtParams(
    val workspaceId: WorkspaceId,
    val uri: String,
    val position: Position,
    val positionEncoding: PositionEncoding,
)

/** `symbol` is absent when no symbol covers the position — an ordinary outcome (ADR-0018). */
@Serializable
public data class SymbolResolveAtResult(
    val document: DocumentReference,
    val symbol: Symbol? = null,
)

@Serializable
public data class SymbolTargetParams(val workspaceId: WorkspaceId, val symbol: SymbolReference)

/**
 * Which neighbours a hierarchy step should return.
 *
 * Named for the relation rather than a direction: a consumer should never have to know whether a
 * given IDE models "up" as supertypes or as callers.
 */
@Serializable
public enum class HierarchyRelation {
    @SerialName("callers")
    CALLERS,

    @SerialName("callees")
    CALLEES,

    @SerialName("supertypes")
    SUPERTYPES,

    @SerialName("subtypes")
    SUBTYPES,
}

@Serializable
public data class SymbolHierarchyParams(
    val workspaceId: WorkspaceId,
    val symbol: SymbolReference,
    val relation: HierarchyRelation,
)

@Serializable
public data class TodoItem(
    val location: Location,
    val text: String,
    val pattern: String? = null,
)

@Serializable
public data class Bookmark(
    val location: Location,
    val description: String? = null,
    val group: String? = null,
)

@Serializable
public data class WorkspaceListBookmarksParams(
    val workspaceId: WorkspaceId,
    val limit: Int? = null,
)

@Serializable
public data class WorkspaceListBookmarksResult(
    val bookmarks: List<Bookmark>,
    val truncated: Boolean,
)

@Serializable
public data class WorkspaceSearchTodosParams(
    val workspaceId: WorkspaceId,
    val uri: String? = null,
    val limit: Int? = null,
)

@Serializable
public data class WorkspaceSearchTodosResult(
    val items: List<TodoItem>,
    val truncated: Boolean,
)

/** Shared by getDefinition, getReferences, and getImplementations (ADR-0024). */
@Serializable
public data class SymbolLocationsResult(
    val locations: List<SymbolLocation>,
    val truncated: Boolean,
)

// ── Diagnostics ──────────────────────────────────────────────────────────────

@Serializable
public data class DiagnosticsGetSnapshotParams(
    val workspaceId: WorkspaceId,
    val documentUris: List<String>? = null,
)

@Serializable
public data class DiagnosticsGetSnapshotResult(
    val documents: List<DocumentDiagnostics>,
    val capturedAt: String,
    val truncated: Boolean,
)

// ── Refactoring ──────────────────────────────────────────────────────────────

@Serializable
public data class RenameOptions(val includeComments: Boolean, val includeStrings: Boolean)

@Serializable
public data class RefactorPrepareParams(
    val workspaceId: WorkspaceId,
    val operation: EditOperation,
    /** The document, for operations scoped to one — reformat and imports among them. */
    val uri: String? = null,
    val symbol: SymbolReference? = null,
    /**
     * Operation-specific values. Left open on the wire because what an operation needs is the
     * IDE's business; constraining it would block refactorings the schema never anticipated.
     */
    val arguments: Map<String, String>? = null,
)

@Serializable
public data class RefactorPrepareResult(val plan: EditPlan)

@Serializable
public data class RefactorPrepareRenameParams(
    val workspaceId: WorkspaceId,
    val symbol: SymbolReference,
    val newName: String,
    val options: RenameOptions,
)

@Serializable
public data class RefactorPrepareRenameResult(val plan: EditPlan)

@Serializable
public data class WorkspaceApplyPlanParams(
    val workspaceId: WorkspaceId,
    val planId: PlanId,
    val includePostApplyDiagnostics: Boolean? = null,
)

@Serializable
public data class WorkspaceDiscardPlanParams(val workspaceId: WorkspaceId, val planId: PlanId)

@Serializable
public data class WorkspaceDiscardPlanResult(val planId: PlanId, val discarded: Boolean)

@Serializable
public data class WorkspaceUndoParams(val workspaceId: WorkspaceId, val undoToken: UndoToken)

// ── Bridge administration ────────────────────────────────────────────────────

@Serializable
public class EmptyParams

@Serializable
public data class BridgeGetStatusResult(
    val daemonVersion: String,
    val protocol: ProtocolRange,
    val startedAt: String,
    val uptimeMs: Long,
    val adapterCount: Int,
    val workspaceCount: Int,
    val sessionCount: Int,
)

@Serializable
public data class BridgeListAdaptersResult(val adapters: List<Adapter>)

@Serializable
public data class BridgeListSessionsResult(val sessions: List<Session>)

// ── Catalogue ────────────────────────────────────────────────────────────────

/** Methods an adapter session may originate. */
public val ADAPTER_ORIGINATED_METHODS: List<String> = listOf(
    "ide/register",
    "ide/unregister",
    "ide/ping",
)

/** Methods the daemon answers itself, without routing to an adapter. */
public val CONSUMER_LOCAL_METHODS: List<String> = listOf(
    "ide/getCapabilities",
    "workspace/list",
    "workspace/get",
    "workspace/getStatus",
    "bridge/getStatus",
    "bridge/listAdapters",
    "bridge/listSessions",
)

/** Methods the daemon routes to an adapter, and which this plugin must therefore handle. */
public val ROUTED_METHODS: List<String> = listOf(
    "document/read",
    "document/getRevision",
    "document/getSymbols",
    "workspace/searchSymbols",
    "workspace/searchTodos",
    "workspace/listBookmarks",
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

public val APPLICATION_METHODS: List<String> =
    ADAPTER_ORIGINATED_METHODS + CONSUMER_LOCAL_METHODS + ROUTED_METHODS
