package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.ErrorData
import com.idebridge.jetbrains.protocol.ErrorResponse
import com.idebridge.jetbrains.protocol.JsonRpcError
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.Notification
import com.idebridge.jetbrains.protocol.Request
import com.idebridge.jetbrains.protocol.Response
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Correlated request/response over an established session.
 *
 * The handshake is complete before this class is used; it speaks only application messages. A
 * response is accepted only when it answers the request that is outstanding: a reply carrying a
 * different identifier is a protocol violation, not a late answer to reinterpret.
 *
 * Notifications arriving while a response is awaited are surfaced to a handler rather than
 * discarded, because the daemon may legitimately push events at any time.
 */
public class RpcClient(
    private val transport: HandshakeClient.Transport,
    private val onNotification: (method: String, raw: String) -> Unit = { _, _ -> },
    private val onRequest: RequestHandler = RequestHandler { _, _ -> Answer.Unsupported },
) {
    private val nextId = AtomicLong(1)

    private companion object {
        /** JSON-RPC reserves -32000..-32099 for application errors; the normalized code is in data. */
        const val JSON_RPC_APPLICATION_ERROR = -32000
    }

    /**
     * Serves an inbound method call.
     *
     * An adapter is not only a caller: the daemon routes a consumer's request to it and expects an
     * answer. Without this the plugin can register capabilities but never honour one, so every
     * operation would have to stay `unavailable`.
     */
    public fun interface RequestHandler {
        public fun handle(method: String, raw: String): Answer
    }

    public sealed interface Answer {
        /** A result, already encoded as the method's response payload. */
        public data class Result(val json: JsonElement) : Answer

        public data class Failed(val code: ErrorCode, val retryable: Boolean = false) : Answer

        /** No handler is registered — answered as a capability the adapter does not have. */
        public data object Unsupported : Answer
    }

    public sealed interface Outcome<out R> {
        public data class Ok<R>(val result: R) : Outcome<R>

        /** The daemon answered with a normalized error. */
        public data class Failed(val code: ErrorCode, val retryable: Boolean) : Outcome<Nothing>

        public data class Broken(val reason: Reason) : Outcome<Nothing>
    }

    public enum class Reason {
        NO_RESPONSE,
        MALFORMED_RESPONSE,
        IDENTIFIER_MISMATCH,
    }

    public fun <P, R> call(
        method: String,
        params: P,
        paramsSerializer: KSerializer<P>,
        resultSerializer: KSerializer<R>,
    ): Outcome<R> {
        val id = JsonPrimitive("jb-${nextId.getAndIncrement()}")
        val request = Request(id = id, method = method, params = params)
        transport.send(
            IdebpJson.encodeToString(Request.serializer(paramsSerializer), request),
        )

        while (true) {
            val raw = transport.receive() ?: return Outcome.Broken(Reason.NO_RESPONSE)

            // Events may arrive between the request and its answer; they are delivered, not dropped.
            val notificationMethod = notificationMethodOrNull(raw)
            if (notificationMethod != null) {
                onNotification(notificationMethod, raw)
                continue
            }

            // The daemon may route a consumer's request while this call is outstanding. Answering
            // it here rather than after keeps the daemon from timing out on a request the adapter
            // has already received, and cannot be confused with this call's own answer because an
            // inbound request carries a `method` and a response never does.
            if (serveIfRequest(raw)) continue

            runCatching { IdebpJson.decodeFromString(ErrorResponse.serializer(), raw) }
                .getOrNull()
                ?.let { error ->
                    if (error.id != id) return Outcome.Broken(Reason.IDENTIFIER_MISMATCH)
                    return Outcome.Failed(error.error.data.code, error.error.data.retryable)
                }

            val response =
                runCatching {
                    IdebpJson.decodeFromString(Response.serializer(resultSerializer), raw)
                }.getOrNull() ?: return Outcome.Broken(Reason.MALFORMED_RESPONSE)
            if (response.id != id) return Outcome.Broken(Reason.IDENTIFIER_MISMATCH)
            return Outcome.Ok(response.result)
        }
    }

    public fun <P> notify(method: String, params: P, paramsSerializer: KSerializer<P>) {
        val notification = Notification(method = method, params = params)
        transport.send(
            IdebpJson.encodeToString(Notification.serializer(paramsSerializer), notification),
        )
    }

    /**
     * Reads and answers inbound traffic until the transport closes.
     *
     * This is what an adapter runs while it has no call of its own outstanding. It returns when the
     * session ends rather than throwing, so a closed connection is an ordinary end of service.
     */
    public fun serve() {
        while (true) {
            val raw = transport.receive()
            if (raw == null) {
                // Nothing arrived within the receive timeout. That is an idle session, not a
                // finished one: returning here would stop serving after the first quiet interval,
                // and the daemon's next routed request would go unanswered until it timed out.
                if (transport.isOpen()) continue else return
            }
            val notificationMethod = notificationMethodOrNull(raw)
            if (notificationMethod != null) {
                onNotification(notificationMethod, raw)
                continue
            }
            // A stray response with no outstanding call is ignored rather than treated as a
            // request: replying to it would put a second answer on the wire.
            serveIfRequest(raw)
        }
    }

    /** Answers `raw` when it is an inbound request. Returns false for anything else. */
    private fun serveIfRequest(raw: String): Boolean {
        val obj = runCatching { IdebpJson.parseToJsonElement(raw) }.getOrNull() as? JsonObject
            ?: return false
        val id = obj["id"] ?: return false
        val method = (obj["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: return false

        // A handler that throws is reported as an internal error rather than killing the session:
        // one failed request must not cost the consumer every other capability.
        val answer = runCatching { onRequest.handle(method, raw) }
            .getOrElse { Answer.Failed(ErrorCode.INTERNAL_ERROR) }

        when (answer) {
            is Answer.Result -> transport.send(
                IdebpJson.encodeToString(
                    Response.serializer(JsonElement.serializer()),
                    Response(id = id as JsonPrimitive, result = answer.json),
                ),
            )

            is Answer.Failed -> sendError(id, answer.code, answer.retryable)
            Answer.Unsupported -> sendError(id, ErrorCode.CAPABILITY_UNAVAILABLE, retryable = false)
        }
        return true
    }

    private fun sendError(id: JsonElement, code: ErrorCode, retryable: Boolean) {
        transport.send(
            IdebpJson.encodeToString(
                ErrorResponse.serializer(),
                ErrorResponse(
                    id = id as JsonPrimitive,
                    error = JsonRpcError(
                        code = JSON_RPC_APPLICATION_ERROR,
                        // The normalized code in `data` is what a consumer acts on; this string is
                        // for humans and deliberately carries nothing about the workspace.
                        message = code.name,
                        data = ErrorData(code = code, retryable = retryable),
                    ),
                ),
            ),
        )
    }

    /** A message with a `method` and no `id` is a notification. */
    private fun notificationMethodOrNull(raw: String): String? {
        val element = runCatching { IdebpJson.parseToJsonElement(raw) }.getOrNull() ?: return null
        val obj = element as? kotlinx.serialization.json.JsonObject ?: return null
        if (obj.containsKey("id")) return null
        val method = obj["method"] as? JsonPrimitive ?: return null
        return if (method.isString) method.content else null
    }
}
