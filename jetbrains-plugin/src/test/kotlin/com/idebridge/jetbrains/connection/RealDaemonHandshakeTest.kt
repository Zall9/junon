package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.EnvironmentKind
import com.idebridge.jetbrains.protocol.HostKind
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.SessionRole
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * Connects to the real IDE Bridge daemon over loopback.
 *
 * Every other Kotlin test exercises the client against scripted input. This one starts the actual
 * daemon process, reads the discovery file it publishes, and completes a genuine authenticated
 * handshake — the real integration path AGENTS.md §6 requires per IDE.
 *
 * It needs Node and the built CLI (`pnpm -r build`). When those are absent the test reports itself
 * as skipped rather than passing silently: a green build must not imply an integration that never
 * ran.
 */
class RealDaemonHandshakeTest {
    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile
    private val cli = File(repositoryRoot, "packages/cli/dist/bin.js")

    private fun nodeExecutable(): String? =
        System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath

    @Test
    fun `completes an authenticated adapter handshake against the real daemon`() {
        val node = nodeExecutable()
        assumeTrue(node != null, "node is not on PATH; the real daemon integration cannot run")
        assumeTrue(cli.isFile, "packages/cli/dist/bin.js is missing; run `pnpm -r build` first")

        val directory: Path = createTempDirectory("ide-bridge-daemon")
        val discoveryFile = directory.resolve("discovery.json")
        val daemon = ProcessBuilder(
            node,
            cli.absolutePath,
            "daemon",
            "--discovery-file",
            discoveryFile.toString(),
            "--log-level",
            "silent",
        )
            .directory(repositoryRoot)
            .redirectErrorStream(true)
            .start()

        try {
            val discovery = awaitDiscovery(discoveryFile)
            assertTrue(
                discovery is DiscoveryReader.Outcome.Ready,
                "daemon did not publish a usable discovery file: $discovery",
            )

            // The daemon writes it 0600; reading it through the same guards the plugin uses in
            // production is part of what this test is proving.
            assertTrue(
                DiscoveryReader.hasPrivatePermissions(discoveryFile),
                "the daemon must publish a private discovery file",
            )

            val transport = WebSocketTransport.connect(discovery.discovery.endpoint)
            try {
                val outcome = HandshakeClient(PeerInfo("ide-bridge-jetbrains", "0.1.0")).connect(
                    transport,
                    discovery.discovery,
                    SessionRole.ADAPTER,
                    EndpointTopology(
                        hostKind = HostKind.LOCAL,
                        environmentKind = EnvironmentKind.LOCAL,
                        uriSchemes = listOf("file"),
                    ),
                    "jetbrains-handshake-1",
                )

                assertTrue(
                    outcome is HandshakeClient.Outcome.Established,
                    "handshake against the real daemon failed: $outcome",
                )
                assertEquals(SessionRole.ADAPTER, outcome.session.role)
                assertEquals("0.1.0", outcome.session.protocolVersion)
                assertTrue(outcome.session.sessionId.isNotEmpty())
            } finally {
                transport.close()
            }
        } finally {
            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)
            daemon.destroyForcibly()
        }
    }

    @Test
    fun `refuses a bad token against the real daemon`() {
        val node = nodeExecutable()
        assumeTrue(node != null, "node is not on PATH; the real daemon integration cannot run")
        assumeTrue(cli.isFile, "packages/cli/dist/bin.js is missing; run `pnpm -r build` first")

        val directory: Path = createTempDirectory("ide-bridge-daemon-auth")
        val discoveryFile = directory.resolve("discovery.json")
        val daemon = ProcessBuilder(
            node,
            cli.absolutePath,
            "daemon",
            "--discovery-file",
            discoveryFile.toString(),
            "--log-level",
            "silent",
        )
            .directory(repositoryRoot)
            .redirectErrorStream(true)
            .start()

        try {
            val discovery = awaitDiscovery(discoveryFile)
            assertTrue(discovery is DiscoveryReader.Outcome.Ready, "no discovery file: $discovery")

            // A wrong token must be refused generically, and the connection closed.
            val forged = discovery.discovery.copy(
                token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            val transport = WebSocketTransport.connect(discovery.discovery.endpoint)
            try {
                val outcome = HandshakeClient(PeerInfo("ide-bridge-jetbrains", "0.1.0")).connect(
                    transport,
                    forged,
                    SessionRole.ADAPTER,
                    EndpointTopology(
                        hostKind = HostKind.LOCAL,
                        environmentKind = EnvironmentKind.LOCAL,
                        uriSchemes = listOf("file"),
                    ),
                    "jetbrains-handshake-bad",
                )
                // Asserting only "not established" would also pass if the connection had simply
                // broken, so the specific refusal is what is checked.
                assertEquals(
                    HandshakeClient.Outcome.Refused(ErrorCode.AUTHENTICATION_FAILED, null),
                    outcome,
                    "expected a typed authentication refusal from the real daemon",
                )
            } finally {
                transport.close()
            }
        } finally {
            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)
            daemon.destroyForcibly()
        }
    }

    private fun awaitDiscovery(path: Path): DiscoveryReader.Outcome {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            if (Files.exists(path)) {
                val outcome = DiscoveryReader.read(path)
                if (outcome is DiscoveryReader.Outcome.Ready) return outcome
            }
            Thread.sleep(100)
        }
        return DiscoveryReader.read(path)
    }
}
