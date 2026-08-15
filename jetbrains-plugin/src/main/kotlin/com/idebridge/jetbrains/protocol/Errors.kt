package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Normalized error responses.
 *
 * Several codes carry structural invariants the schema enforces — `INDEX_NOT_READY` must be
 * retryable, `STALE_DOCUMENT` must carry a current revision, `AMBIGUOUS_SYMBOL` at least two
 * candidates, `PARTIAL_APPLY` the documents it did modify. Those are validated by the daemon and by
 * the canonical fixtures; this type carries the shape.
 */

@Serializable
public enum class ErrorCode {
    @SerialName("INVALID_REQUEST")
    INVALID_REQUEST,

    @SerialName("UNSUPPORTED_PROTOCOL_VERSION")
    UNSUPPORTED_PROTOCOL_VERSION,

    @SerialName("AUTHENTICATION_FAILED")
    AUTHENTICATION_FAILED,

    @SerialName("WORKSPACE_NOT_FOUND")
    WORKSPACE_NOT_FOUND,

    @SerialName("DOCUMENT_NOT_FOUND")
    DOCUMENT_NOT_FOUND,

    @SerialName("ADAPTER_NOT_FOUND")
    ADAPTER_NOT_FOUND,

    @SerialName("ADAPTER_DISCONNECTED")
    ADAPTER_DISCONNECTED,

    @SerialName("CAPABILITY_UNAVAILABLE")
    CAPABILITY_UNAVAILABLE,

    @SerialName("INDEX_NOT_READY")
    INDEX_NOT_READY,

    @SerialName("STALE_DOCUMENT")
    STALE_DOCUMENT,

    @SerialName("STALE_SYMBOL")
    STALE_SYMBOL,

    @SerialName("AMBIGUOUS_SYMBOL")
    AMBIGUOUS_SYMBOL,

    @SerialName("INVALID_IDENTIFIER")
    INVALID_IDENTIFIER,

    @SerialName("PRECONDITION_FAILED")
    PRECONDITION_FAILED,

    @SerialName("PLAN_NOT_FOUND")
    PLAN_NOT_FOUND,

    @SerialName("PLAN_EXPIRED")
    PLAN_EXPIRED,

    @SerialName("PROVIDER_FAILED")
    PROVIDER_FAILED,

    @SerialName("TIMEOUT")
    TIMEOUT,

    @SerialName("CANCELLED")
    CANCELLED,

    @SerialName("PERMISSION_DENIED")
    PERMISSION_DENIED,

    @SerialName("PARTIAL_APPLY")
    PARTIAL_APPLY,

    @SerialName("INTERNAL_ERROR")
    INTERNAL_ERROR,
}

@Serializable
public data class ErrorDetails(
    val adapterId: AdapterId? = null,
    val workspaceId: WorkspaceId? = null,
    val documentUri: String? = null,
    val planId: PlanId? = null,
    val capability: String? = null,
    val currentRevision: Revision? = null,
    val candidates: List<SymbolLocator>? = null,
    val modifiedDocuments: List<ModifiedDocument>? = null,
)

@Serializable
public data class ErrorData(
    val code: ErrorCode,
    val retryable: Boolean,
    val details: ErrorDetails? = null,
)

@Serializable
public data class JsonRpcError(val code: Int, val message: String, val data: ErrorData)

@Serializable
public data class ErrorResponse(
    val jsonrpc: String = "2.0",
    val id: JsonRpcId,
    val error: JsonRpcError,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
    }
}
