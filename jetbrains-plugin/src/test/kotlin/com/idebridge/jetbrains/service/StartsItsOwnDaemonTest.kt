package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.DaemonStarter
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.io.path.createTempDirectory

/**
 * An IDE that finds no daemon starts one — the half of "one click and nothing else" a click cannot do.
 *
 * Measured on 2026-09-15: a daemon died when the disk filled, and the IDE beside it sat unlinked for
 * ninety minutes. Nothing on the machine could bring a daemon back, because this plugin only ever
 * connected — there was no `ProcessBuilder` anywhere in it — and only the VS Code extension could
 * spawn one. A dashboard button cannot cover that case either: it needs somebody to press it.
 *
 * So the link path starts one itself, from the command an installer recorded. This test is the
 * proof: a project with no daemon anywhere near it ends up linked, to a daemon that did not exist
 * when the test began.
 */
class StartsItsOwnDaemonTest : BasePlatformTestCase() {

    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile
    private val cli = File(repositoryRoot, "packages/cli/dist/bin.js")
    private var started: Path? = null

    override fun tearDown() {
        try {
            // Whatever this test brought to life, it takes away.
            started?.let { discovery ->
                runCatching {
                    val pid = Regex("\"pid\"\\s*:\\s*(\\d+)").find(Files.readString(discovery))?.groupValues?.get(1)
                    if (pid != null) Runtime.getRuntime().exec(arrayOf("kill", pid)).waitFor()
                }
            }
        } finally {
            super.tearDown()
        }
    }

    private fun node(): String {
        val found = System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath
        assertNotNull("node is not on PATH, so no daemon can be started and this proves nothing", found)
        assertTrue("packages/cli/dist/bin.js is missing; run `pnpm -r build` first", cli.isFile)
        return found!!
    }

    fun `test a project with no daemon anywhere ends up linked to one this IDE started`() {
        val node = node()
        val directory = createTempDirectory("ide-bridge-own-daemon")
        val discovery = directory.resolve("discovery.json")
        started = discovery

        val command = directory.resolve("daemon.json")
        Files.writeString(
            command,
            """{"argv": ["$node", "${cli.absolutePath}", "daemon", "--discovery-file", "$discovery",
               "--log-level", "silent"], "directory": "${repositoryRoot.absolutePath}"}""",
        )
        Files.setPosixFilePermissions(command, PosixFilePermissions.fromString("rw-------"))

        assertFalse("the test must start with no daemon, or it proves nothing", Files.exists(discovery))

        val service = BridgeDaemonConnectionService(
            discoveryPathProvider = { discovery },
            daemonStarter = { DaemonStarter.start(it, command, timeoutMs = 40_000) },
        )

        val outcome = service.link(project)

        assertTrue(
            "the IDE must start the recorded daemon and link to it, got: $outcome",
            outcome is BridgeDaemonConnectionService.Outcome.Linked,
        )
        assertTrue("the daemon it started must have published its endpoint", Files.exists(discovery))
        service.unlink(project)
    }

    fun `test a refused command file leaves the link refused, and starts nothing`() {
        val node = node()
        val directory = createTempDirectory("ide-bridge-own-daemon-refused")
        val discovery = directory.resolve("discovery.json")

        val command = directory.resolve("daemon.json")
        Files.writeString(
            command,
            """{"argv": ["$node", "${cli.absolutePath}", "daemon", "--discovery-file", "$discovery"],
               "directory": "${repositoryRoot.absolutePath}"}""",
        )
        // What somebody else could have written into.
        Files.setPosixFilePermissions(command, PosixFilePermissions.fromString("rw-rw-rw-"))

        val service = BridgeDaemonConnectionService(
            discoveryPathProvider = { discovery },
            daemonStarter = { DaemonStarter.start(it, command, timeoutMs = 10_000) },
        )

        val outcome = service.link(project)

        assertEquals(
            "a command file anyone can rewrite must not be run",
            BridgeDaemonConnectionService.Outcome.Refused(
                BridgeDaemonConnectionService.Outcome.Refusal.NO_DAEMON,
            ),
            outcome,
        )
        assertFalse("nothing may have been started from it", Files.exists(discovery))
    }
}
