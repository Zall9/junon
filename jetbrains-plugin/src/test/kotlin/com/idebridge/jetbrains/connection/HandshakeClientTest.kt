package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.DiscoveryFile
import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.EnvironmentKind
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.HostKind
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.HandshakeRequest
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.ProtocolRange
import com.idebridge.jetbrains.protocol.SessionRole
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HandshakeClientTest {
    private val discovery = DiscoveryFile(
        protocolVersion = "0.1.0",
        endpoint = "ws://127.0.0.1:51234/rpc",
        token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        pid = 99,
        startedAt = "2026-08-02T10:00:00.000Z",
    )
    private val topology = EndpointTopology(
        hostKind = HostKind.LOCAL,
        environmentKind = EnvironmentKind.LOCAL,
        uriSchemes = listOf("file"),
    )
    private val client = HandshakeClient(PeerInfo("ide-bridge-jetbrains", "0.1.0"))

    /** Records what the client sent and replays a scripted answer. */
    private class ScriptedTransport(private val reply: (String) -> String?) :
        HandshakeClient.Transport {
        var sent: String? = null
        var closed = false

        override fun send(message: String) {
            sent = message
        }

        override fun receive(): String? = reply(sent ?: "")

        override fun close() {
            closed = true
        }
    }

    private fun successResponse(id: String, role: String = "adapter", version: String = "0.1.0") =
        """
        {"jsonrpc":"2.0","id":"$id","result":{"sessionId":"session_1","role":"$role",
        "protocolVersion":"$version","daemonInfo":{"name":"ide-bridge-daemon","version":"0.1.0"},
        "topology":{"hostKind":"local","environmentKind":"local","uriSchemes":["file"]}}}
        """.trimIndent().replace("\n", "")

    @Test
    fun `sends a conforming handshake carrying the discovery token`() {
        val transport = ScriptedTransport { successResponse("hs-1") }
        val outcome =
            client.connect(transport, discovery, SessionRole.ADAPTER, topology, "hs-1")

        assertTrue(outcome is HandshakeClient.Outcome.Established, "got $outcome")
        assertEquals("session_1", outcome.session.sessionId)

        // The request must be exactly what the canonical contract accepts.
        val sent = IdebpJson.decodeFromString(HandshakeRequest.serializer(), transport.sent!!)
        assertEquals("bridge/handshake", sent.method)
        assertEquals(discovery.token, sent.params.authentication.token)
        assertEquals(SessionRole.ADAPTER, sent.params.role)
        assertEquals(ProtocolRange("0.1.0", "0.1.0"), sent.params.protocol)
    }

    @Test
    fun `classifies a typed refusal instead of treating it as a failure`() {
        val refusal =
            """{"jsonrpc":"2.0","id":"hs-2","error":{"code":-32001,"message":"Authentication failed",
            "data":{"code":"AUTHENTICATION_FAILED","retryable":false}}}""".trimIndent()
                .replace("\n", "")
        val outcome = client.connect(
            ScriptedTransport { refusal },
            discovery,
            SessionRole.ADAPTER,
            topology,
            "hs-2",
        )

        assertEquals(
            HandshakeClient.Outcome.Refused(ErrorCode.AUTHENTICATION_FAILED, null),
            outcome,
        )
    }

    @Test
    fun `surfaces the range the daemon supports when the version is refused`() {
        val refusal =
            """{"jsonrpc":"2.0","id":"hs-3","error":{"code":-32002,"message":"Unsupported version",
            "data":{"code":"UNSUPPORTED_PROTOCOL_VERSION","retryable":false,
            "supportedProtocol":{"minimum":"0.2.0","maximum":"0.3.0"}}}}""".trimIndent()
                .replace("\n", "")
        val outcome = client.connect(
            ScriptedTransport { refusal },
            discovery,
            SessionRole.ADAPTER,
            topology,
            "hs-3",
        )

        assertEquals(
            HandshakeClient.Outcome.Refused(
                ErrorCode.UNSUPPORTED_PROTOCOL_VERSION,
                ProtocolRange("0.2.0", "0.3.0"),
            ),
            outcome,
        )
    }

    @Test
    fun `refuses a response that answers a different request`() {
        val outcome = client.connect(
            ScriptedTransport { successResponse("someone-else") },
            discovery,
            SessionRole.ADAPTER,
            topology,
            "hs-4",
        )
        assertEquals(
            HandshakeClient.Outcome.Failed(HandshakeClient.Reason.IDENTIFIER_MISMATCH),
            outcome,
        )
    }

    @Test
    fun `refuses a session granted under a different role`() {
        val outcome = client.connect(
            ScriptedTransport { successResponse("hs-5", role = "consumer") },
            discovery,
            SessionRole.ADAPTER,
            topology,
            "hs-5",
        )
        assertEquals(HandshakeClient.Outcome.Failed(HandshakeClient.Reason.ROLE_MISMATCH), outcome)
    }

    @Test
    fun `refuses a version the client never offered`() {
        val outcome = client.connect(
            ScriptedTransport { successResponse("hs-6", version = "9.9.9") },
            discovery,
            SessionRole.ADAPTER,
            topology,
            "hs-6",
        )
        assertEquals(
            HandshakeClient.Outcome.Failed(HandshakeClient.Reason.UNSUPPORTED_VERSION),
            outcome,
        )
    }

    @Test
    fun `reports silence and off-contract answers distinctly`() {
        assertEquals(
            HandshakeClient.Outcome.Failed(HandshakeClient.Reason.NO_RESPONSE),
            client.connect(
                ScriptedTransport { null },
                discovery,
                SessionRole.ADAPTER,
                topology,
                "hs-7",
            ),
        )
        assertEquals(
            HandshakeClient.Outcome.Failed(HandshakeClient.Reason.MALFORMED_RESPONSE),
            client.connect(
                ScriptedTransport { """{"jsonrpc":"2.0","id":"hs-8","result":{}}""" },
                discovery,
                SessionRole.ADAPTER,
                topology,
                "hs-8",
            ),
        )
    }
}
