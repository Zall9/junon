package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Two-phase edit types (ADR-0004, ADR-0007).
 *
 * `editorVersion` is absent on a precondition covering content no editor holds open (ADR-0020);
 * `contentHash` carries the guarantee in both cases.
 */

@Serializable
public data class DocumentRevisionPrecondition(
    val type: String = "documentRevision",
    val uri: String,
    val editorVersion: Int? = null,
    val contentHash: ContentHash,
    val workspaceEpoch: Int,
) {
    init {
        require(type == "documentRevision") { "Unsupported precondition type: $type" }
    }
}

@Serializable
public data class ChangeSummary(
    val kind: String = "textEdit",
    val uri: String,
    val editCount: Int,
) {
    init {
        require(kind == "textEdit") { "Unsupported change kind: $kind" }
    }
}

@Serializable
public enum class EditOperation {
    @SerialName("rename")
    RENAME,

    @SerialName("reformat")
    REFORMAT,

    @SerialName("optimizeImports")
    OPTIMIZE_IMPORTS,

    @SerialName("extractMethod")
    EXTRACT_METHOD,

    @SerialName("inline")
    INLINE,

    @SerialName("move")
    MOVE,

    @SerialName("changeSignature")
    CHANGE_SIGNATURE,

    @SerialName("quickFix")
    QUICK_FIX,
}

@Serializable
public data class EditPlan(
    val planId: PlanId,
    val adapterId: AdapterId,
    val sessionId: SessionId,
    val workspaceId: WorkspaceId,
    val expiresAt: String,
    val operation: EditOperation,
    val guarantee: Guarantee,
    val atomicity: Atomicity,
    val preconditions: List<DocumentRevisionPrecondition>,
    val changes: List<ChangeSummary>,
    val warnings: List<String>,
)

@Serializable
public data class ModifiedDocument(
    val document: DocumentReference,
    val beforeHash: ContentHash,
    val afterHash: ContentHash,
)

@Serializable
public data class UndoToken(
    val id: UndoTokenId,
    val adapterId: AdapterId,
    val sessionId: SessionId,
    val workspaceId: WorkspaceId,
    val expiresAt: String? = null,
)

@Serializable
public data class ModificationResult(
    val modifiedDocuments: List<ModifiedDocument>,
    val undoToken: UndoToken? = null,
    val diagnostics: List<DocumentDiagnostics>? = null,
)
