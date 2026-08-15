package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.connection.DiscoveryReader
import com.idebridge.jetbrains.connection.HandshakeClient
import com.idebridge.jetbrains.connection.RpcClient
import com.idebridge.jetbrains.connection.WebSocketTransport
import com.idebridge.jetbrains.protocol.EmptyParams
import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.EnvironmentKind
import com.idebridge.jetbrains.protocol.HostKind
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.SessionRole
import com.idebridge.jetbrains.protocol.Support
import com.idebridge.jetbrains.protocol.WorkspaceListParams
import com.idebridge.jetbrains.protocol.WorkspaceListResult
import com.idebridge.jetbrains.protocol.WorkspaceStatus
import com.idebridge.jetbrains.protocol.WorkspaceGetStatusResult
import com.idebridge.jetbrains.protocol.WorkspaceIdParams
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
 * Registers this adapter with the real daemon and reads back what the daemon now believes.
 *
 * This closes the loop the handshake test opened: the plugin does not merely authenticate, it
 * publishes a workspace and a capability set that a separate consumer session can observe. Anything
 * the plugin claims here is claimed to a real registry that validates it.
 */
class RealDaemonRegistrationTest {
    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile
    private val cli = File(repositoryRoot, "packages/cli/dist/bin.js")

    private data class Snapshot(
        override val name: String = "jetbrains-fixture",
        override val rootUris: List<String> = listOf("file:///workspace/jetbrains-fixture"),
        override val trust: WorkspaceModel.TrustState = WorkspaceModel.TrustState.GRANTED,
    ) : WorkspaceModel.ProjectSnapshot

    private fun nodeExecutable(): String? =
        System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath

    private val topology = EndpointTopology(
        hostKind = HostKind.LOCAL,
        environmentKind = EnvironmentKind.LOCAL,
        uriSchemes = listOf("file"),
    )

    @Test
    fun `registers a workspace the daemon then reports to a consumer`() {
        val node = nodeExecutable()
        assumeTrue(node != null, "node is not on PATH; the real daemon integration cannot run")
        assumeTrue(cli.isFile, "packages/cli/dist/bin.js is missing; run `pnpm -r build` first")

        val directory: Path = createTempDirectory("ide-bridge-registration")
        val discoveryFile = directory.resolve("discovery.json")
        val daemon = ProcessBuilder(
            node,
            cli.absolutePath,
            "daemon",
            "--discovery-file",
            discoveryFile.toString(),
            "--log-level",
            "silent",
        ).directory(repositoryRoot).redirectErrorStream(true).start()

        try {
            val discovery = awaitDiscovery(discoveryFile)
            assertTrue(discovery is DiscoveryReader.Outcome.Ready, "no discovery file: $discovery")

            val adapterId = WorkspaceModel.createIdentifier("adapter_")
            val model = WorkspaceModel(adapterId)
            val workspace = model.snapshot(Snapshot())
            assertTrue(workspace != null)

            val adapterTransport = WebSocketTransport.connect(discovery.discovery.endpoint)
            val consumerTransport = WebSocketTransport.connect(discovery.discovery.endpoint)
            try {
                val handshake = HandshakeClient(PeerInfo("ide-bridge-jetbrains", "0.1.0"))
                assertTrue(
                    handshake.connect(
                        adapterTransport,
                        discovery.discovery,
                        SessionRole.ADAPTER,
                        topology,
                        "reg-adapter",
                    ) is HandshakeClient.Outcome.Established,
                )
                assertTrue(
                    handshake.connect(
                        consumerTransport,
                        discovery.discovery,
                        SessionRole.CONSUMER,
                        topology,
                        "reg-consumer",
                    ) is HandshakeClient.Outcome.Established,
                )

                val adapter = RpcClient(adapterTransport)
                val registration =
                    AdapterRegistration(adapterId, "0.1.0", "IC-2025.2")
                        .register(adapter, listOf(workspace))
                assertTrue(
                    registration is AdapterRegistration.Outcome.Registered,
                    "registration failed: $registration",
                )
                assertEquals(workspace.workspaceId, registration.workspaces.single().workspaceId)

                // A separate consumer session must now see the workspace this plugin published.
                val consumer = RpcClient(consumerTransport)
                val listed = consumer.call(
                    "workspace/list",
                    WorkspaceListParams(),
                    WorkspaceListParams.serializer(),
                    WorkspaceListResult.serializer(),
                )
                assertTrue(listed is RpcClient.Outcome.Ok, "workspace/list failed: $listed")
                assertEquals(
                    listOf(workspace.workspaceId),
                    listed.result.workspaces.map { it.workspaceId },
                )
                assertEquals("jetbrains-fixture", listed.result.workspaces.single().name)

                // Unimplemented operations are advertised as unavailable, not omitted, so a
                // consumer receives a truthful refusal rather than an unexplained absence.
                val status: WorkspaceStatus = consumer.call(
                    "workspace/getStatus",
                    WorkspaceIdParams(workspace.workspaceId),
                    WorkspaceIdParams.serializer(),
                    WorkspaceGetStatusResult.serializer(),
                ).let {
                    assertTrue(it is RpcClient.Outcome.Ok, "workspace/getStatus failed: $it")
                    it.result.status
                }
                assertEquals(workspace.workspaceId, status.workspaceId)

                assertTrue(
                    AdapterRegistration(adapterId, "0.1.0", "IC-2025.2").unregister(adapter),
                    "clean deregistration must succeed",
                )
            } finally {
                adapterTransport.close()
                consumerTransport.close()
            }
        } finally {
            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)
            daemon.destroyForcibly()
        }
    }

    @Test
    fun `advertises exactly what it serves, and explains the rest`() {
        val capabilities =
            AdapterRegistration("adapter_x", "0.1.0", "IC-2025.2").capabilities()

        assertTrue(capabilities.isNotEmpty())
        val advertised = capabilities.filterValues { it.support != Support.UNAVAILABLE }.keys
        // Advertisement is driven by the router, so a method cannot be announced as supported
        // without a handler behind it, nor implemented without being announced.
        assertEquals(AdapterRouter.IMPLEMENTED_METHODS, advertised)

        for ((method, capability) in capabilities) {
            if (method in AdapterRouter.IMPLEMENTED_METHODS) {
                assertEquals(Support.NATIVE, capability.support, "$method comes from the IDE's PSI")
            } else {
                assertEquals(
                    Support.UNAVAILABLE,
                    capability.support,
                    "$method must not claim support the adapter does not have yet",
                )
                assertTrue(capability.reason != null, "$method must explain why it is unavailable")
            }
        }
        // Nothing is omitted: an unimplemented method is a truthful refusal, not an absence.
        assertTrue("workspace/searchSymbols" in capabilities)
        assertTrue("document/read" in capabilities)
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
