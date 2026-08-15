package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Session establishment (ADR-0001).
 *
 * `bridge/handshake` is the first application message on every connection; nothing else is accepted
 * before a session exists.
 */

@Serializable
public enum class SessionRole {
    @SerialName("adapter")
    ADAPTER,

    @SerialName("consumer")
    CONSUMER,
}

@Serializable
public data class HandshakeAuthentication(val method: String = "token", val token: String) {
    init {
        require(method == "token") { "Unsupported authentication method: $method" }
    }
}

@Serializable
public data class ProtocolRange(val minimum: String, val maximum: String)

@Serializable
public data class PeerInfo(val name: String, val version: String)

@Serializable
public data class HandshakeParams(
    val authentication: HandshakeAuthentication,
    val role: SessionRole,
    val protocol: ProtocolRange,
    val topology: EndpointTopology,
    val clientInfo: PeerInfo,
)

@Serializable
public data class HandshakeRequest(
    val jsonrpc: String = "2.0",
    val id: JsonRpcId,
    val method: String = "bridge/handshake",
    val params: HandshakeParams,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
        require(method == "bridge/handshake") { "Not a handshake request: $method" }
    }
}

@Serializable
public data class HandshakeResult(
    val sessionId: SessionId,
    val role: SessionRole,
    val protocolVersion: String,
    val daemonInfo: PeerInfo,
    val topology: EndpointTopology,
)

/**
 * A handshake failure.
 *
 * This is a distinct contract from the application error response: the daemon sends at most one and
 * then closes, the identifier may be null when the request could not be parsed, and an unsupported
 * version carries the range the daemon does support so the peer can decide whether to retry.
 */
@Serializable
public data class HandshakeErrorData(
    val code: ErrorCode,
    val retryable: Boolean,
    val supportedProtocol: ProtocolRange? = null,
)

@Serializable
public data class HandshakeError(
    val code: Int,
    val message: String,
    val data: HandshakeErrorData,
)

@Serializable
public data class HandshakeErrorResponse(
    val jsonrpc: String = "2.0",
    // Required, and `null` when the request identifier could not be recovered — the one place the
    // contract distinguishes an explicit JSON null from an absent key. Typed non-nullable so the
    // literal is carried as JsonNull and always encoded.
    val id: JsonRpcId,
    val error: HandshakeError,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
    }
}

@Serializable
public data class HandshakeResponse(
    val jsonrpc: String = "2.0",
    val id: JsonRpcId,
    val result: HandshakeResult,
) {
    init {
        require(jsonrpc == "2.0") { "Unsupported JSON-RPC version: $jsonrpc" }
    }
}
