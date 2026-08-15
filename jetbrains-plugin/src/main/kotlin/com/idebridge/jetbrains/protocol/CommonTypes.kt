package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/**
 * Shared IDEBP value types.
 *
 * Identifiers are plain strings on the wire; they are aliased here so signatures read as the
 * protocol does without introducing wrapper types that kotlinx.serialization would have to unwrap.
 */

public typealias AdapterId = String
public typealias SessionId = String
public typealias WorkspaceId = String
public typealias RootId = String
public typealias SymbolHandleId = String
public typealias PlanId = String
public typealias UndoTokenId = String
public typealias ContentHash = String

/**
 * A JSON-RPC request identifier: a non-empty string or an integer.
 *
 * Kept as a [JsonPrimitive] so a numeric identifier travels back exactly as it arrived. Coercing it
 * to a string would silently change the value the peer correlates on.
 */
public typealias JsonRpcId = JsonPrimitive


@Serializable
public enum class PositionEncoding {
    @SerialName("utf-16")
    UTF16,

    @SerialName("utf-8")
    UTF8,

    @SerialName("utf-32")
    UTF32,
}

@Serializable
public data class Position(val line: Int, val character: Int)

@Serializable
public data class Range(val start: Position, val end: Position)

@Serializable
public data class Location(
    val uri: String,
    val range: Range,
    val positionEncoding: PositionEncoding,
)

/**
 * `editorVersion` is absent for content that is not open in an editor buffer (ADR-0020).
 * `contentHash` is the authoritative identity in both cases.
 */
@Serializable
public data class Revision(
    val editorVersion: Int? = null,
    val contentHash: ContentHash,
    val workspaceEpoch: Int,
)

@Serializable
public data class DocumentReference(
    val workspaceId: WorkspaceId,
    val rootId: RootId,
    val uri: String,
    val logicalPath: String? = null,
    val revision: Revision,
    val positionEncoding: PositionEncoding,
    val languageId: String? = null,
    val isDirty: Boolean,
)

@Serializable
public data class DocumentContent(val document: DocumentReference, val text: String)

@Serializable
public enum class WorkspaceTrust {
    @SerialName("trusted")
    TRUSTED,

    @SerialName("untrusted")
    UNTRUSTED,

    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
public data class WorkspaceRoot(val rootId: RootId, val name: String, val uri: String)

@Serializable
public data class Workspace(
    val workspaceId: WorkspaceId,
    val adapterId: AdapterId,
    val name: String,
    val roots: List<WorkspaceRoot>,
    val workspaceEpoch: Int,
    val trust: WorkspaceTrust,
)

@Serializable
public enum class ReadinessState {
    @SerialName("initializing")
    INITIALIZING,

    @SerialName("indexing")
    INDEXING,

    @SerialName("ready")
    READY,

    @SerialName("degraded")
    DEGRADED,

    @SerialName("disconnected")
    DISCONNECTED,
}

@Serializable
public data class ReadinessProgress(val known: Boolean, val percentage: Double? = null)

@Serializable
public data class WorkspaceStatus(
    val workspaceId: WorkspaceId,
    val state: ReadinessState,
    val capabilitiesUnavailable: List<String>,
    val progress: ReadinessProgress,
)

@Serializable
public enum class Support {
    @SerialName("native")
    NATIVE,

    @SerialName("provider")
    PROVIDER,

    @SerialName("adapter")
    ADAPTER,

    @SerialName("unavailable")
    UNAVAILABLE,
}

@Serializable
public enum class Guarantee {
    @SerialName("semantic")
    SEMANTIC,

    @SerialName("syntactic")
    SYNTACTIC,

    @SerialName("anchored-text")
    ANCHORED_TEXT,

    @SerialName("raw-text")
    RAW_TEXT,
}

@Serializable
public enum class Atomicity {
    @SerialName("none")
    NONE,

    @SerialName("text-only")
    TEXT_ONLY,

    @SerialName("semantic")
    SEMANTIC,
}

/**
 * Capability dimensions are operation-dependent (ADR-0005): an omitted dimension is not applicable
 * and must never be inferred, which is why every one but `support` is nullable and unencoded when
 * absent.
 */
@Serializable
public data class Capability(
    val support: Support,
    val guarantee: Guarantee? = null,
    val preview: Boolean? = null,
    val atomicity: Atomicity? = null,
    val reason: String? = null,
)

@Serializable
public enum class HostKind {
    @SerialName("local")
    LOCAL,

    @SerialName("remote-workspace")
    REMOTE_WORKSPACE,

    @SerialName("web")
    WEB,

    @SerialName("gateway")
    GATEWAY,
}

@Serializable
public enum class EnvironmentKind {
    @SerialName("local")
    LOCAL,

    @SerialName("wsl")
    WSL,

    @SerialName("dev-container")
    DEV_CONTAINER,

    @SerialName("codespace")
    CODESPACE,

    @SerialName("ssh")
    SSH,

    @SerialName("jetbrains-remote")
    JETBRAINS_REMOTE,

    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
public enum class UriMappingDirection {
    @SerialName("client-to-daemon")
    CLIENT_TO_DAEMON,

    @SerialName("daemon-to-client")
    DAEMON_TO_CLIENT,

    @SerialName("bidirectional")
    BIDIRECTIONAL,
}

@Serializable
public data class UriMapping(
    val sourceUriPrefix: String,
    val targetUriPrefix: String,
    val direction: UriMappingDirection,
)

@Serializable
public data class EndpointTopology(
    val hostKind: HostKind,
    val environmentKind: EnvironmentKind,
    val uriSchemes: List<String>,
    val uriMappings: List<UriMapping>? = null,
)
