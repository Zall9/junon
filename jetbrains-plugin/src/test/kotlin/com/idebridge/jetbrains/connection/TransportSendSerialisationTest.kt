package com.idebridge.jetbrains.connection

import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import junit.framework.TestCase

/**
 * One send at a time, because the JDK's `WebSocket` permits exactly that.
 *
 * A second `sendText` begun before the first completes throws `IllegalStateException: Send pending`.
 * This transport had a single caller for months — the serving thread, answering requests in turn —
 * and gained two more on 2026-08-14: the readiness heartbeat and the document-change announcer, both
 * on pooled threads. The defect appeared in a real IDE within minutes, as a burst of
 *
 *     could not announce a document change: IllegalStateException: Send pending
 *
 * with every one of those notifications lost. Nothing in the type system says a transport may only
 * be used from one thread, so the transport enforces it.
 */
class TransportSendSerialisationTest : TestCase() {

    /** Records whether two sends were ever in flight together. */
    private class CountingSocket : WebSocket {
        val inFlight = AtomicInteger()
        val overlaps = AtomicInteger()
        val sends = AtomicInteger()

        override fun sendText(data: CharSequence, last: Boolean): CompletableFuture<WebSocket> {
            if (inFlight.incrementAndGet() > 1) overlaps.incrementAndGet()
            // Long enough that unsynchronised callers would certainly collide.
            Thread.sleep(5)
            sends.incrementAndGet()
            inFlight.decrementAndGet()
            return CompletableFuture.completedFuture(this)
        }

        override fun sendBinary(data: ByteBuffer, last: Boolean) =
            CompletableFuture.completedFuture<WebSocket>(this)

        override fun sendPing(message: ByteBuffer) = CompletableFuture.completedFuture<WebSocket>(this)

        override fun sendPong(message: ByteBuffer) = CompletableFuture.completedFuture<WebSocket>(this)

        override fun sendClose(statusCode: Int, reason: String) =
            CompletableFuture.completedFuture<WebSocket>(this)

        override fun request(n: Long) = Unit

        override fun getSubprotocol(): String = ""

        override fun isOutputClosed(): Boolean = false

        override fun isInputClosed(): Boolean = false

        override fun abort() = Unit
    }

    fun `test concurrent senders never overlap on the socket`() {
        val socket = CountingSocket()
        val transport = WebSocketTransport(socket, LinkedBlockingQueue(), Duration.ofSeconds(1))
        val senders = 8
        val each = 10
        val start = CountDownLatch(1)
        val done = CountDownLatch(senders)

        repeat(senders) { index ->
            Thread {
                start.await()
                repeat(each) { transport.send("{\"n\":$index}") }
                done.countDown()
            }.start()
        }
        start.countDown()
        assertTrue("senders did not finish", done.await(30, TimeUnit.SECONDS))

        assertEquals(senders * each, socket.sends.get())
        assertEquals(
            "two sends were in flight at once; the JDK would have thrown 'Send pending'",
            0,
            socket.overlaps.get(),
        )
    }
}
