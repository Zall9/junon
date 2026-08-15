package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.EmptyParams
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.IdebpJson
import java.util.concurrent.LinkedBlockingQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The adapter's server side.
 *
 * Registering capabilities is only half of being an adapter: the daemon routes a consumer's request
 * to it and waits. Until this existed the plugin could publish a workspace but never honour a single
 * operation, so everything had to stay `unavailable`.
 */
class RpcClientServeTest {

    private class FakeTransport : HandshakeClient.Transport {
        val outbound = mutableListOf<String>()
        private val inbound = LinkedBlockingQueue<String>()
        private var closed = false

        fun deliver(message: String) = inbound.put(message)

        fun endOfStream() {
            closed = true
        }

        override fun send(message: String) {
            outbound.add(message)
        }

        /** Mirrors the real transport: `null` on an idle poll, not only on closure. */
        override fun receive(): String? = inbound.poll()

        override fun isOpen(): Boolean = !closed

        override fun close() {
            closed = true
        }
    }

    private fun request(id: String, method: String): String = IdebpJson.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("id", JsonPrimitive(id))
            put("method", JsonPrimitive(method))
            put("params", buildJsonObject { })
        },
    )

    private fun parse(raw: String) = IdebpJson.parseToJsonElement(raw).jsonObject

    @Test
    fun `answers an inbound request with the handler's result`() {
        val transport = FakeTransport()
        val client = RpcClient(transport, onRequest = { method, _ ->
            assertEquals("document/getSymbols", method)
            RpcClient.Answer.Result(buildJsonObject { put("symbols", buildJsonObject { }) })
        })
        transport.deliver(request("d-1", "document/getSymbols"))
        transport.endOfStream()

        client.serve()

        val reply = parse(transport.outbound.single())
        assertEquals("d-1", reply["id"]?.jsonPrimitive?.content)
        assertTrue(reply.containsKey("result"))
    }

    @Test
    fun `answers an unhandled method as a capability it does not have`() {
        val transport = FakeTransport()
        transport.deliver(request("d-2", "refactor/prepareRename"))
        transport.endOfStream()

        RpcClient(transport).serve()

        val reply = parse(transport.outbound.single())
        // Silence would leave the daemon waiting for a timeout; a truthful refusal is the answer.
        assertEquals(
            ErrorCode.CAPABILITY_UNAVAILABLE.name,
            reply["error"]!!.jsonObject["data"]!!.jsonObject["code"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `a handler that throws costs one request, not the session`() {
        val transport = FakeTransport()
        val client = RpcClient(transport, onRequest = { _, _ -> error("provider blew up") })
        transport.deliver(request("d-3", "document/getSymbols"))
        transport.deliver(request("d-4", "document/getSymbols"))
        transport.endOfStream()

        client.serve()

        assertEquals(2, transport.outbound.size, "the session must survive a failing handler")
        for (raw in transport.outbound) {
            assertEquals(
                ErrorCode.INTERNAL_ERROR.name,
                parse(raw)["error"]!!.jsonObject["data"]!!.jsonObject["code"]!!.jsonPrimitive.content,
            )
        }
    }

    @Test
    fun `serves a request that arrives while one of its own calls is outstanding`() {
        val transport = FakeTransport()
        val client = RpcClient(transport, onRequest = { _, _ ->
            RpcClient.Answer.Result(buildJsonObject { put("served", JsonPrimitive(true)) })
        })
        // The daemon routes a consumer request before answering the adapter's own call. Deferring
        // it until afterwards would let the daemon time out on a request already received.
        transport.deliver(request("inbound-1", "document/getSymbols"))
        transport.deliver(
            IdebpJson.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("jsonrpc", JsonPrimitive("2.0"))
                    put("id", JsonPrimitive("jb-1"))
                    put("result", JsonPrimitive("done"))
                },
            ),
        )
        transport.endOfStream()

        val outcome = client.call(
            "workspace/list",
            EmptyParams(),
            EmptyParams.serializer(),
            String.serializer(),
        )

        assertIs<RpcClient.Outcome.Ok<String>>(outcome)
        assertEquals("done", outcome.result)
        val served = transport.outbound.map { parse(it) }.single {
            it["id"]?.jsonPrimitive?.content == "inbound-1"
        }
        assertTrue(served.containsKey("result"))
    }

    @Test
    fun `a notification is delivered, never answered`() {
        val transport = FakeTransport()
        val seen = mutableListOf<String>()
        val client = RpcClient(transport, onNotification = { method, _ -> seen.add(method) })
        transport.deliver(
            IdebpJson.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("jsonrpc", JsonPrimitive("2.0"))
                    put("method", JsonPrimitive("workspace/statusChanged"))
                    put("params", buildJsonObject { })
                },
            ),
        )
        transport.endOfStream()

        client.serve()

        assertEquals(listOf("workspace/statusChanged"), seen)
        // Replying to a notification would put an unmatched response on the wire.
        assertTrue(transport.outbound.isEmpty())
    }

    @Test
    fun `a stray response is ignored rather than answered`() {
        val transport = FakeTransport()
        transport.deliver(
            IdebpJson.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("jsonrpc", JsonPrimitive("2.0"))
                    put("id", JsonPrimitive("stale-1"))
                    put("result", JsonPrimitive("late"))
                },
            ),
        )
        transport.endOfStream()

        RpcClient(transport).serve()

        // It has an id but no method: answering it would put a second response on the wire for a
        // request this side never received.
        assertTrue(transport.outbound.isEmpty())
    }

    @Test
    fun `keeps serving through an idle period and stops only when the peer goes`() {
        val transport = FakeTransport()
        val client = RpcClient(transport, onRequest = { _, _ ->
            RpcClient.Answer.Result(buildJsonObject { put("served", JsonPrimitive(true)) })
        })
        // The real transport returns null when nothing arrived within its receive timeout. Treating
        // that as the end of the session made the adapter stop serving after ten quiet seconds, so
        // the daemon's next routed request went unanswered until it timed out.
        val serving = Thread { client.serve() }.apply { isDaemon = true; start() }
        Thread.sleep(50)
        assertTrue(serving.isAlive, "an idle session must not end service")

        transport.deliver(request("late-1", "document/getSymbols"))
        Thread.sleep(100)
        assertEquals(1, transport.outbound.size, "a request after the silence must still be served")

        transport.endOfStream()
        serving.join(2_000)
        assertFalse(serving.isAlive, "a closed transport must end service")
    }
}
