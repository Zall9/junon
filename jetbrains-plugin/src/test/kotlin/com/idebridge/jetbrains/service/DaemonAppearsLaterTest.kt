package com.idebridge.jetbrains.service

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createTempDirectory

/**
 * A daemon started after the IDE, which is the ordinary order and was the one that did not work.
 *
 * Measured on 2026-09-15, on a real machine and for ninety minutes: GoLand open on a project, the
 * plugin loaded, a daemon running — and no adapter. The project had opened while the daemon was
 * dead, `BridgeStartupActivity` was refused once, and nothing ever looked again. The daemon that
 * started three minutes later could not be seen by an IDE that had stopped watching, so the
 * dashboard said "no IDE attached" beside an IDE that was very much attached to the project.
 *
 * Nothing could have caught it: every test of linking ran against a daemon that was either there
 * from the start or never. The state in between — refused, then a daemon appears — had no test,
 * and it is the state a person is in every time they start the daemon by hand.
 *
 * So this one starts the real daemon **after** the refusal, touches nothing else, and waits for the
 * link to happen on its own.
 */
class DaemonAppearsLaterTest : BasePlatformTestCase() {

    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile
    private val cli = File(repositoryRoot, "packages/cli/dist/bin.js")
    private var daemon: Process? = null

    override fun tearDown() {
        try {
            daemon?.destroy()
            daemon?.waitFor()
        } finally {
            super.tearDown()
        }
    }

    private fun nodeExecutable(): String? =
        System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath

    /**
     * The daemon these tests need, or a failure saying so.
     *
     * Deliberately not an assumption that skips. A test of "the IDE finds a daemon that appears"
     * which quietly passes when there is no daemon to appear is worse than no test: it is a green
     * line that attests to nothing, and this file exists because something went unnoticed for
     * ninety minutes.
     */
    private fun requireRealDaemon(): String {
        val node = nodeExecutable()
        assertNotNull("node is not on PATH, so the real daemon cannot start and this proves nothing", node)
        assertTrue(
            "packages/cli/dist/bin.js is missing; run `pnpm -r build` before this suite",
            cli.isFile,
        )
        return node!!
    }

    private fun startDaemon(discoveryFile: Path, node: String) {
        daemon = ProcessBuilder(
            node, cli.absolutePath, "daemon", "--discovery-file", discoveryFile.toString(),
            "--log-level", "silent",
        ).directory(repositoryRoot).redirectErrorStream(true).start()
    }

    private fun await(what: String, timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(100)
        }
        fail("timed out after ${timeoutMs}ms waiting for $what")
    }

    fun `test a project refused for want of a daemon links itself when one appears`() {
        val node = requireRealDaemon()

        val directory = createTempDirectory("ide-bridge-late-daemon")
        val discoveryFile = directory.resolve("discovery.json")
        // Fast enough that this test is worth running, and the production default is what ships.
        val service = BridgeDaemonConnectionService(
            discoveryPathProvider = { discoveryFile },
            daemonWatchIntervalMs = 200,
        )

        // 1. The IDE is there first, and there is nothing to link to.
        val refusal = service.link(project)
        assertEquals(
            "the fixture must be refused for want of a daemon, not for anything else",
            BridgeDaemonConnectionService.Outcome.Refused(
                BridgeDaemonConnectionService.Outcome.Refusal.NO_DAEMON,
            ),
            refusal,
        )
        assertFalse(service.isLinked(project))

        // 2. The daemon starts, the way a person starts it: nothing tells the IDE.
        startDaemon(discoveryFile, node)
        await("the daemon to publish its discovery file", 30_000) { Files.exists(discoveryFile) }

        // 3. Nobody links anything. The project must arrive on its own.
        await("the project to link itself to the daemon that appeared", 30_000) { service.isLinked(project) }
        assertNotNull("a linked project must have a workspace", service.workspaceIdOf(project))
        // The link is to the process this test started, not to a daemon that happened to be running
        // on the machine: the discovery file is this test's own, and that process is still alive.
        assertTrue("the daemon this test started must be the one serving it", daemon!!.isAlive)

        service.unlink(project)
    }

    fun `test unlinking stops the watch, so nothing relinks behind the user's back`() {
        val node = requireRealDaemon()

        val directory = createTempDirectory("ide-bridge-unlink-wins")
        val discoveryFile = directory.resolve("discovery.json")
        val service = BridgeDaemonConnectionService(
            discoveryPathProvider = { discoveryFile },
            daemonWatchIntervalMs = 200,
        )

        service.link(project)          // refused: a watch is now running
        service.unlink(project)        // the user's decision, on a project that is not linked

        startDaemon(discoveryFile, node)
        await("the daemon to publish its discovery file", 30_000) { Files.exists(discoveryFile) }
        // Long enough for several watch intervals to have passed had one survived.
        Thread.sleep(2_000)

        assertFalse(
            "unlinking must outrank the watch: a daemon appearing cannot undo the user's decision",
            service.isLinked(project),
        )
    }
}
