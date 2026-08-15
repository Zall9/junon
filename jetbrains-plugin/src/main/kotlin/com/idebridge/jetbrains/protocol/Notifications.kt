package com.idebridge.jetbrains.protocol

import kotlinx.serialization.Serializable

/**
 * Event notifications.
 *
 * Direction matters: everything in [ADAPTER_OUTBOUND_NOTIFICATION_METHODS] is something this plugin
 * announces, while `adapter/disconnected` is produced by the daemon and `$/cancelRequest` travels
 * from consumer to daemon. Sending a notification in the wrong direction closes the session.
 */

@Serializable
public data class Notification<P>(
    val jsonrpc: String = "2.0",
    val method: String,
    val params: P,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
        require(method in NOTIFICATION_METHODS) { "Unknown IDEBP notification: $method" }
    }
}

@Serializable
public data class CapabilitiesChangedParams(
    val adapterId: AdapterId,
    val capabilities: Map<String, Capability>,
)

@Serializable
public data class WorkspaceOpenedParams(val workspace: Workspace)

@Serializable
public data class WorkspaceClosedParams(val workspaceId: WorkspaceId, val adapterId: AdapterId)

@Serializable
public data class WorkspaceRootsChangedParams(
    val workspaceId: WorkspaceId,
    val adapterId: AdapterId,
    val roots: List<WorkspaceRoot>,
    val workspaceEpoch: Int,
)

@Serializable
public data class WorkspaceReadinessChangedParams(val status: WorkspaceStatus)

/** Trust changing invalidates nothing else about the workspace (ADR-0022). */
@Serializable
public data class WorkspaceTrustChangedParams(
    val workspaceId: WorkspaceId,
    val adapterId: AdapterId,
    val trust: WorkspaceTrust,
)

@Serializable
public data class DocumentEventParams(val document: DocumentReference)

/** A deleted document has an identity but no content, so it carries no revision (ADR-0022). */
@Serializable
public data class DocumentDeletedParams(val workspaceId: WorkspaceId, val uri: String)

@Serializable
public data class DocumentRenamedParams(
    val workspaceId: WorkspaceId,
    val previousUri: String,
    val document: DocumentReference,
)

@Serializable
public data class DiagnosticsChangedParams(
    val workspaceId: WorkspaceId,
    val documentUri: String,
    val revision: Revision,
)

@Serializable
public data class AdapterDisconnectedParams(val adapterId: AdapterId, val reason: String)

@Serializable
public data class CancelRequestParams(val id: String)

public val ADAPTER_OUTBOUND_NOTIFICATION_METHODS: List<String> = listOf(
    "adapter/capabilitiesChanged",
    "workspace/opened",
    "workspace/closed",
    "workspace/rootsChanged",
    "workspace/readinessChanged",
    "workspace/trustChanged",
    "document/opened",
    "document/changed",
    "document/saved",
    "document/closed",
    "document/deleted",
    "document/renamed",
    "diagnostics/changed",
)

public val NOTIFICATION_METHODS: List<String> =
    ADAPTER_OUTBOUND_NOTIFICATION_METHODS + listOf("adapter/disconnected", "\$/cancelRequest")
