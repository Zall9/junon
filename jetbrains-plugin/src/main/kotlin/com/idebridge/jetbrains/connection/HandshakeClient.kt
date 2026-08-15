package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.DiscoveryFile
import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.HandshakeAuthentication
import com.idebridge.jetbrains.protocol.HandshakeErrorResponse
import com.idebridge.jetbrains.protocol.HandshakeParams
import com.idebridge.jetbrains.protocol.HandshakeRequest
import com.idebridge.jetbrains.protocol.HandshakeResponse
import com.idebridge.jetbrains.protocol.HandshakeResult
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.ProtocolRange
import com.idebridge.jetbrains.protocol.SessionRole
import kotlinx.serialization.json.JsonPrimitive

/**
 * Establishes an authenticated IDEBP session.
 *
 * `bridge/handshake` is the first application message on every connection and nothing else is
 * accepted before a session exists (ADR-0001). This class owns only the message exchange and its
 * validation; the socket itself is supplied through [Transport] so the logic is testable without a
 * network and so the transport can be replaced without touching the protocol rules.
 */
public class HandshakeClient(
    private val clientInfo: PeerInfo,
    private val supportedProtocol: ProtocolRange = ProtocolRange("0.1.0", "0.1.0"),
) {
    /** A bidirectional text channel. Implementations must not reorder or coalesce messages. */
    public interface Transport {
        public fun send(message: String)

        /** Blocks for the next message, or returns `null` when the peer closed or timed out. */
        public fun receive(): String?
        /**
         * False once the peer has gone. [receive] returning `null` only means nothing arrived
         * within its timeout, which is an idle session, not a finished one — conflating the two
         * makes a server stop serving after the first quiet interval.
         */
        public fun isOpen(): Boolean = true

        public fun close()
    }

    public sealed interface Outcome {
        public data class Established(val session: HandshakeResult) : Outcome

        /** The daemon answered with a typed refusal. */
        public data class Refused(val code: ErrorCode, val supportedProtocol: ProtocolRange?) :
            Outcome

        /** No usable answer: the peer closed, timed out, or replied off-contract. */
        public data class Failed(val reason: Reason) : Outcome
    }

    public enum class Reason {
        NO_RESPONSE,
        MALFORMED_RESPONSE,
        IDENTIFIER_MISMATCH,
        ROLE_MISMATCH,
        UNSUPPORTED_VERSION,
    }

    public fun connect(
        transport: Transport,
        discovery: DiscoveryFile,
        role: SessionRole,
        topology: EndpointTopology,
        requestId: String,
    ): Outcome {
        val request = HandshakeRequest(
            id = JsonPrimitive(requestId),
            params = HandshakeParams(
                authentication = HandshakeAuthentication(token = discovery.token),
                role = role,
                protocol = supportedProtocol,
                topology = topology,
                clientInfo = clientInfo,
            ),
        )
        transport.send(IdebpJson.encodeToString(HandshakeRequest.serializer(), request))

        val raw = transport.receive() ?: return Outcome.Failed(Reason.NO_RESPONSE)

        // A refusal is a valid, expected answer, so it is classified before the success shape.
        runCatching { IdebpJson.decodeFromString(HandshakeErrorResponse.serializer(), raw) }
            .getOrNull()
            ?.let { error ->
                return Outcome.Refused(error.error.data.code, error.error.data.supportedProtocol)
            }

        val response =
            runCatching { IdebpJson.decodeFromString(HandshakeResponse.serializer(), raw) }
                .getOrNull() ?: return Outcome.Failed(Reason.MALFORMED_RESPONSE)

        // Correlation and role are checked before the session is treated as usable: a response
        // answering a different request, or granting a different role, is not this session.
        if (response.id != request.id) return Outcome.Failed(Reason.IDENTIFIER_MISMATCH)
        if (response.result.role != role) return Outcome.Failed(Reason.ROLE_MISMATCH)
        if (!isSupported(response.result.protocolVersion)) {
            return Outcome.Failed(Reason.UNSUPPORTED_VERSION)
        }
        return Outcome.Established(response.result)
    }

    /**
     * The daemon selects one discrete version, which must be one this client offered. The range is
     * inclusive and currently a single point, so equality with either bound is the whole rule.
     */
    private fun isSupported(selected: String): Boolean =
        selected == supportedProtocol.minimum || selected == supportedProtocol.maximum
}
