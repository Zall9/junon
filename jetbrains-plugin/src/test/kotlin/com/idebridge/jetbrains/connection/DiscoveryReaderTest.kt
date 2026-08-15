package com.idebridge.jetbrains.connection

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DiscoveryReaderTest {
    private val directory: Path = createTempDirectory("ide-bridge-discovery")

    private fun writeDiscovery(
        name: String,
        endpoint: String = "ws://127.0.0.1:51234/rpc",
        permissions: String = "rw-------",
    ): Path {
        val file = directory.resolve(name)
        Files.writeString(
            file,
            """
            {
              "protocolVersion": "0.1.0",
              "endpoint": "$endpoint",
              "token": "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
              "pid": 4242,
              "startedAt": "2026-08-02T10:00:00.000Z"
            }
            """.trimIndent(),
        )
        runCatching {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString(permissions))
        }
        return file
    }

    @Test
    fun `reads a private loopback discovery file`() {
        val outcome = DiscoveryReader.read(writeDiscovery("ready.json"))
        assertTrue(outcome is DiscoveryReader.Outcome.Ready, "expected a usable file, got $outcome")
        assertEquals("ws://127.0.0.1:51234/rpc", outcome.discovery.endpoint)
        assertEquals(4242, outcome.discovery.pid)
    }

    @Test
    fun `refuses a file other users can read`() {
        val outcome = DiscoveryReader.read(writeDiscovery("open.json", permissions = "rw-r--r--"))
        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.PERMISSIONS_TOO_OPEN),
            outcome,
        )
    }

    @Test
    fun `refuses an endpoint that is not loopback`() {
        // The daemon must never be reached anywhere but loopback, whatever the file claims.
        val outcome =
            DiscoveryReader.read(writeDiscovery("public.json", endpoint = "ws://10.0.0.5:51234/rpc"))
        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.ENDPOINT_NOT_LOOPBACK),
            outcome,
        )
    }

    @Test
    fun `refuses a symlink rather than following it`() {
        val target = writeDiscovery("target.json")
        val link = directory.resolve("link.json")
        val created = runCatching { Files.createSymbolicLink(link, target) }.isSuccess
        if (!created) return

        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.NOT_A_REGULAR_FILE),
            DiscoveryReader.read(link),
        )
    }

    @Test
    fun `refuses a missing, oversized, or malformed file`() {
        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.MISSING),
            DiscoveryReader.read(directory.resolve("absent.json")),
        )

        val oversized = directory.resolve("big.json")
        Files.writeString(oversized, "x".repeat(5000))
        runCatching {
            Files.setPosixFilePermissions(oversized, PosixFilePermissions.fromString("rw-------"))
        }
        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.TOO_LARGE),
            DiscoveryReader.read(oversized),
        )

        val malformed = directory.resolve("bad.json")
        Files.writeString(malformed, """{"endpoint": "ws://127.0.0.1:1/rpc"}""")
        runCatching {
            Files.setPosixFilePermissions(malformed, PosixFilePermissions.fromString("rw-------"))
        }
        assertEquals(
            DiscoveryReader.Outcome.Unusable(DiscoveryReader.Reason.MALFORMED),
            DiscoveryReader.read(malformed),
        )
    }

    @Test
    fun `accepts only loopback hosts on the rpc path`() {
        assertTrue(DiscoveryReader.isLoopbackEndpoint("ws://127.0.0.1:1/rpc"))
        assertTrue(DiscoveryReader.isLoopbackEndpoint("ws://[::1]:65535/rpc"))
        for (rejected in listOf(
            "ws://127.0.0.1:51234/other",
            "wss://127.0.0.1:51234/rpc",
            "ws://127.0.0.2:51234/rpc",
            "ws://localhost:51234/rpc",
            "ws://127.0.0.1:70000/rpc",
            "ws://127.0.0.1:51234/rpc?token=x",
        )) {
            assertTrue(!DiscoveryReader.isLoopbackEndpoint(rejected), "$rejected must be refused")
        }
    }

    @Test
    fun `never surfaces file contents in a failure`() {
        val malformed = directory.resolve("secretish.json")
        Files.writeString(malformed, """{"token": "SUPER-SECRET-TOKEN-VALUE"}""")
        runCatching {
            Files.setPosixFilePermissions(malformed, PosixFilePermissions.fromString("rw-------"))
        }
        val outcome = DiscoveryReader.read(malformed)
        assertTrue(!outcome.toString().contains("SUPER-SECRET"), "failure leaked file content")
    }
}
