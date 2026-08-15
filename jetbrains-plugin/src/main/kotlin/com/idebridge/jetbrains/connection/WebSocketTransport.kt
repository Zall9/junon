package com.idebridge.jetbrains.connection

import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletionStage
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * A [HandshakeClient.Transport] over a real loopback WebSocket.
 *
 * Uses the JDK's own client rather than adding a dependency or reaching into IntelliJ's bundled
 * Netty: fewer moving parts, and nothing platform-internal to break across IDE versions.
 *
 * Text frames only, size-bounded, and no redirect following — a redirect would move the connection
 * off the loopback endpoint the discovery file authorised.
 */
public class WebSocketTransport internal constructor(
    private val socket: WebSocket,
    private val inbound: LinkedBlockingQueue<Message>,
    private val receiveTimeout: Duration,
) : HandshakeClient.Transport {

    /**
     * Internal rather than private only so the constructor can be, and the constructor is internal
     * only so a test can build this over a socket that counts overlapping sends.
     */
    internal sealed interface Message {
        data class Text(val value: String) : Message

        data object Closed : Message
    }

    @Volatile
    private var closed: Boolean = false

    /**
     * One send at a time, because the JDK's `WebSocket` permits exactly that.
     *
     * A second `sendText` begun before the first completes fails with `IllegalStateException: Send
     * pending`. This transport had one caller — the serving thread, answering requests in turn — and
     * gained two more on 2026-08-14: the readiness heartbeat and the document-change announcer, both
     * on pooled threads. Measured immediately, in a real IDE: a burst of `Send pending`, every one
     * of those notifications lost.
     *
     * Serialising here rather than in each caller: the constraint belongs to the socket, and a rule
     * that every future caller must remember is a rule that will be forgotten.
     */
    private val sending = ReentrantLock()

    override fun isOpen(): Boolean = !closed

    override fun send(message: String) {
        if (message.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            throw IllegalArgumentException("Outbound IDEBP message exceeds the size ceiling")
        }
        sending.withLock { socket.sendText(message, true).join() }
    }

    override fun receive(): String? {
        val next = inbound.poll(receiveTimeout.toMillis(), TimeUnit.MILLISECONDS) ?: return null
        return when (next) {
            is Message.Text -> next.value
            // The peer ended the connection. `isOpen` must say so from here on, or this is
            // indistinguishable from the timeout above: `serve()` returns on a closed transport and
            // continues on an idle one, and until 2026-08-14 `closed` was set only by our own
            // `close()`. So a daemon that hung up left the adapter spinning on nulls forever,
            // believing it was serving a workspace the daemon had forgotten. Measured with a real
            // IDE: two minutes of polling, no reconnection, and only an IDE restart cleared it.
            Message.Closed -> {
                closed = true
                null
            }
        }
    }

    override fun close() {
        closed = true
        runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "client shutdown").join() }
        runCatching { socket.abort() }
    }

    public companion object {
        /** Matches the daemon's frame ceiling; anything larger is refused before it is sent. */
        public const val MAX_MESSAGE_BYTES: Int = 10 * 1024 * 1024

        public fun connect(
            endpoint: String,
            connectTimeout: Duration = Duration.ofSeconds(5),
            receiveTimeout: Duration = Duration.ofSeconds(10),
        ): WebSocketTransport {
            require(DiscoveryReader.isLoopbackEndpoint(endpoint)) {
                "Refusing to connect to a non-loopback endpoint"
            }
            val inbound = LinkedBlockingQueue<Message>()
            val client = HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build()
            val socket = client.newWebSocketBuilder()
                .connectTimeout(connectTimeout)
                .buildAsync(URI.create(endpoint), Listener(inbound))
                .get(connectTimeout.toMillis(), TimeUnit.MILLISECONDS)
            return WebSocketTransport(socket, inbound, receiveTimeout)
        }
    }

    /**
     * Reassembles partial text frames. The JDK delivers a message in pieces; treating a piece as a
     * complete message would hand malformed JSON to the protocol layer.
     */
    private class Listener(private val inbound: LinkedBlockingQueue<Message>) : WebSocket.Listener {
        private val partial = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            webSocket.request(1)
        }

        override fun onText(
            webSocket: WebSocket,
            data: CharSequence,
            last: Boolean,
        ): CompletionStage<*>? {
            partial.append(data)
            if (partial.length > MAX_MESSAGE_BYTES) {
                partial.setLength(0)
                webSocket.abort()
                inbound.put(Message.Closed)
                return null
            }
            if (last) {
                inbound.put(Message.Text(partial.toString()))
                partial.setLength(0)
            }
            webSocket.request(1)
            return null
        }

        /** Binary frames are not part of the contract; receiving one ends the connection. */
        override fun onBinary(
            webSocket: WebSocket,
            data: java.nio.ByteBuffer,
            last: Boolean,
        ): CompletionStage<*>? {
            webSocket.abort()
            inbound.put(Message.Closed)
            return null
        }

        // Marks the transport closed so a server stops serving on a real closure, not on silence.
        override fun onClose(
            webSocket: WebSocket,
            statusCode: Int,
            reason: String,
        ): CompletionStage<*>? {
            // The daemon states why it closed us, and that reason is the only diagnosis an
            // adapter author gets when a response is refused. Discarding it, as this did, is how
            // a rejection becomes an unexplained PROVIDER_FAILED.
            if (reason.isNotBlank()) {
                com.intellij.openapi.diagnostic.logger<WebSocketTransport>()
                    .warn("[IDE Bridge] daemon closed the session (" + statusCode + "): " + reason)
            }
            inbound.put(Message.Closed)
            return null
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            inbound.put(Message.Closed)
        }
    }
}
