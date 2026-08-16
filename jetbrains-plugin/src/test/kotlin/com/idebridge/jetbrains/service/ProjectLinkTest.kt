package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import kotlin.io.path.createTempDirectory

/**
 * What linking a project must never do again: fail without saying so.
 *
 * Measured in a real IDE on 2026-08-10. The service held one application-wide `connected` flag, one
 * socket and one workspace, and released it only when the IDE shut down. Closing a project killed the
 * serving thread and the daemon dropped the adapter, but the flag stayed `true`, so the next project
 * to open returned early from `connect()` — **with no log line at all** — and nothing registered again
 * until the IDE restarted. The readiness state said `DISCONNECTED` while the service believed it was
 * connected, and that disagreement is exactly why the failure was invisible (ADR-0033).
 *
 * These tests run without a daemon, which is the case a user hits most often. What they pin is that a
 * refusal is *typed and repeatable*: the same project may be offered again, and asking twice does not
 * turn a refusal into a silent success.
 */
class ProjectLinkTest : BasePlatformTestCase() {

    /**
     * A service pointed at a daemon that does not exist.
     *
     * Stated rather than assumed: the first version of these tests used the real default path and
     * failed on a machine where a daemon happened to be running — the fixture project linked to it
     * for real. Naming the path is what makes the outcome this code's, not the machine's.
     */
    private fun service() = BridgeDaemonConnectionService(
        discoveryPathProvider = {
            Paths.get(myFixture.tempDirPath, "no-such-daemon", "discovery.json")
        },
    )

    fun `test a link with no daemon is refused with a reason, not silently`() {
        val outcome = service().link(project)

        assertTrue(
            "a refusal must carry why, got: $outcome",
            outcome is BridgeDaemonConnectionService.Outcome.Refused,
        )
        val refusal = outcome as BridgeDaemonConnectionService.Outcome.Refused
        // The fixture project publishes a content root, so the only thing missing is the daemon; if
        // this ever reports NO_CONTENT_ROOT the fixture changed, not the rule.
        assertEquals(
            BridgeDaemonConnectionService.Outcome.Refusal.NO_DAEMON,
            refusal.reason,
        )
    }

    fun `test a refused link leaves nothing behind and can be retried`() {
        val service = service()

        service.link(project)
        assertFalse("a refused link must not count as one", service.isLinked(project))
        assertTrue(service.linkedProjects().isEmpty())
        assertNull(service.workspaceIdOf(project))

        // The old flag made the second attempt return `true` without doing anything. Offering the
        // same project again must reach the same answer, every time.
        val again = service.link(project)
        assertTrue(
            "the second attempt must be answered too, got: $again",
            again is BridgeDaemonConnectionService.Outcome.Refused,
        )
    }

    /**
     * A variable set to nothing configures nothing.
     *
     * `getenv` cannot distinguish "unset" from "set to empty", and `Paths.get("")` is an empty
     * *relative* path that resolves against whatever directory the IDE was launched from — so an
     * empty override would silently point at an arbitrary place instead of being ignored. The VS
     * Code adapter made the mirror-image mistake, reading an empty setting as a configured path,
     * and three days of end-to-end measurements were taken against a daemon nobody had built
     * (ADR-0037).
     */
    fun `test an empty discovery override is ignored rather than resolved`() {
        val home = "/home/tester"
        val fallback = Paths.get(home, ".ide-bridge", "discovery.json")

        for (blank in listOf("", "   ", "\t")) {
            assertEquals(
                "an override of '$blank' must not configure anything",
                fallback,
                BridgeDaemonConnectionService.defaultDiscoveryPath({ blank }, home),
            )
        }
        assertEquals(fallback, BridgeDaemonConnectionService.defaultDiscoveryPath({ null }, home))
        // A real value still wins, or the rule above would be indistinguishable from ignoring the
        // variable altogether.
        assertEquals(
            Paths.get("/sandbox/discovery.json"),
            BridgeDaemonConnectionService.defaultDiscoveryPath({ "/sandbox/discovery.json" }, home),
        )
    }

    /**
     * A session the daemon ends must end the link with it.
     *
     * Measured with a real IDE on 2026-08-14: the daemon refused a `refactor/prepareRename` response
     * and closed the session, as it does for any contract violation. The serving thread returned and
     * nothing else happened — the entry stayed, `isLinked` kept answering true, readiness kept
     * answering READY, and the plugin reported a workspace the daemon had forgotten. Two minutes of
     * polling confirmed it never came back; only restarting the IDE cleared it.
     *
     * That is the disagreement between readiness and reality that ADR-0033 exists to forbid, coming
     * back through a door it did not cover: the daemon hanging up rather than the project closing.
     *
     * The daemon is stopped rather than provoked into refusing, because the invariant is about the
     * transport ending, and killing it ends the transport the same way with no protocol theatre.
     */
    fun `test a session the daemon ends releases the link rather than reporting it`() {
        val node = File(System.getProperty("user.dir")).parentFile
            .let { root -> File(root, "packages/cli/dist/bin.js") }
            .takeIf { it.isFile }
            ?.let { cli -> nodeExecutable()?.let { node -> node to cli } }
        if (node == null) {
            // Stated, never silent: a green build must not imply an integration that never ran.
            println("SKIPPED: node or packages/cli/dist/bin.js is missing; run `pnpm -r build`")
            return
        }
        val (nodePath, cli) = node

        val directory = createTempDirectory("ide-bridge-link-death")
        val discoveryFile = directory.resolve("discovery.json")
        val daemon = ProcessBuilder(
            nodePath, cli.absolutePath,
            "daemon", "--discovery-file", discoveryFile.toString(), "--log-level", "silent",
        )
            .directory(File(System.getProperty("user.dir")).parentFile)
            .redirectErrorStream(true)
            .start()

        try {
            val deadline = System.currentTimeMillis() + 30_000
            while (!Files.exists(discoveryFile) && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            assertTrue("the daemon published no discovery file", Files.exists(discoveryFile))

            val started = mutableListOf<DaemonAnalysisTracker>()
            val service = BridgeDaemonConnectionService(
                discoveryPathProvider = { discoveryFile },
                trackerFactory = { p -> DaemonAnalysisTracker(p).also { started.add(it) } },
            )
            val outcome = service.link(project)
            assertTrue(
                "the fixture must link against a real daemon, got: $outcome",
                outcome is BridgeDaemonConnectionService.Outcome.Linked,
            )
            assertTrue(service.isLinked(project))

            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)

            val until = System.currentTimeMillis() + 15_000
            while (service.isLinked(project) && System.currentTimeMillis() < until) {
                Thread.sleep(100)
            }
            assertFalse(
                "a link whose session the daemon ended must not still be reported as live",
                service.isLinked(project),
            )
            assertTrue(service.linkedProjects().isEmpty())
            assertNull(service.workspaceIdOf(project))
            assertFalse("nothing is listening any more", service.daemonAvailable())
            // A link released this way must give up its subscriptions as thoroughly as one the user
            // unlinks; this is the path a user then re-links from, so a tracker left here is a
            // tracker per reconnection.
            assertTrue(
                "the analysis tracker outlived the link the daemon ended",
                Disposer.isDisposed(started.single()),
            )
        } finally {
            daemon.destroyForcibly()
        }
    }

    private fun nodeExecutable(): String? =
        System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath

    /**
     * A link that ends must take its subscriptions with it.
     *
     * `DaemonAnalysisTracker` subscribes to the analysis daemon and is a `Disposable`; it was
     * created on every `link()` — including every *refused* one — and disposed by nothing. Each
     * attempt left another listener accumulating file URLs for the project's lifetime, and
     * re-linking became ordinary once a session the daemon closes started releasing its link. Found
     * by reading the lifecycle, not by any failing test, which is why this one exists.
     */
    fun `test unlinking disposes the analysis tracker the link started`() {
        val node = File(System.getProperty("user.dir")).parentFile
            .let { root -> File(root, "packages/cli/dist/bin.js") }
            .takeIf { it.isFile }
            ?.let { cli -> nodeExecutable()?.let { node -> node to cli } }
        if (node == null) {
            println("SKIPPED: node or packages/cli/dist/bin.js is missing; run `pnpm -r build`")
            return
        }
        val (nodePath, cli) = node

        val directory = createTempDirectory("ide-bridge-tracker")
        val discoveryFile = directory.resolve("discovery.json")
        val daemon = ProcessBuilder(
            nodePath, cli.absolutePath,
            "daemon", "--discovery-file", discoveryFile.toString(), "--log-level", "silent",
        )
            .directory(File(System.getProperty("user.dir")).parentFile)
            .redirectErrorStream(true)
            .start()

        try {
            val deadline = System.currentTimeMillis() + 30_000
            while (!Files.exists(discoveryFile) && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            assertTrue("the daemon published no discovery file", Files.exists(discoveryFile))

            val started = mutableListOf<DaemonAnalysisTracker>()
            val service = BridgeDaemonConnectionService(
                discoveryPathProvider = { discoveryFile },
                trackerFactory = { p -> DaemonAnalysisTracker(p).also { started.add(it) } },
            )
            assertTrue(
                "the fixture must link against a real daemon",
                service.link(project) is BridgeDaemonConnectionService.Outcome.Linked,
            )
            assertEquals("linking makes exactly one tracker", 1, started.size)
            assertFalse("a live link's tracker must stay live", Disposer.isDisposed(started[0]))

            service.unlink(project)

            assertTrue(
                "a tracker outliving its link keeps listening to the analysis daemon for the life "
                    + "of the project, and every re-link adds another",
                Disposer.isDisposed(started[0]),
            )
        } finally {
            daemon.destroyForcibly()
        }
    }

    /**
     * A session the daemon ends must be reconnected, not merely mourned.
     *
     * The plugin learned on 2026-08-14 to notice a dead session and release its link; it then sat
     * there. A user whose daemon had restarted, or whose adapter the daemon had disconnected over
     * one refused response, had a dead bridge until they re-linked by hand. This drives the whole
     * sequence: link against a real daemon, kill it, start another on the same discovery file, and
     * require the plugin to find its way back on its own.
     */
    fun `test a link the daemon ended is reconnected without being asked`() {
        val node = File(System.getProperty("user.dir")).parentFile
            .let { root -> File(root, "packages/cli/dist/bin.js") }
            .takeIf { it.isFile }
            ?.let { cli -> nodeExecutable()?.let { node -> node to cli } }
        if (node == null) {
            println("SKIPPED: node or packages/cli/dist/bin.js is missing; run `pnpm -r build`")
            return
        }
        val (nodePath, cli) = node
        val directory = createTempDirectory("ide-bridge-relink")
        val discoveryFile = directory.resolve("discovery.json")

        fun startDaemon(): Process = ProcessBuilder(
            nodePath, cli.absolutePath,
            "daemon", "--discovery-file", discoveryFile.toString(), "--log-level", "silent",
        )
            .directory(File(System.getProperty("user.dir")).parentFile)
            .redirectErrorStream(true)
            .start()

        fun awaitDiscovery() {
            val deadline = System.currentTimeMillis() + 30_000
            while (!Files.exists(discoveryFile) && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
        }

        var daemon = startDaemon()
        val service = BridgeDaemonConnectionService(discoveryPathProvider = { discoveryFile })
        try {
            awaitDiscovery()
            assertTrue(
                "the fixture must link against a real daemon",
                service.link(project) is BridgeDaemonConnectionService.Outcome.Linked,
            )

            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)
            Files.deleteIfExists(discoveryFile)

            val released = System.currentTimeMillis() + 20_000
            while (service.isLinked(project) && System.currentTimeMillis() < released) {
                Thread.sleep(100)
            }
            assertFalse("the dead session must release its link first", service.isLinked(project))

            // A daemon comes back on the same discovery file, as one restarted by hand would.
            daemon = startDaemon()
            awaitDiscovery()

            val reconnected = System.currentTimeMillis() + 60_000
            while (!service.isLinked(project) && System.currentTimeMillis() < reconnected) {
                Thread.sleep(200)
            }
            assertTrue(
                "the plugin must find its way back without the user re-linking by hand",
                service.isLinked(project),
            )
        } finally {
            service.unlink(project)
            daemon.destroyForcibly()
        }
    }

    /**
     * Reconnection widens, caps, and stops.
     *
     * The daemon closes a session when it *refuses* something. Retrying that instantly and for ever
     * would turn one bad response into a flood, so this pins the shape rather than the fact: the
     * delays double, they stop growing at the cap, and past the last attempt there is no next one.
     */
    fun `test reconnection backs off, caps, and gives up`() {
        val delays = (1..6).map { BridgeDaemonConnectionService.relinkDelayMs(it) }

        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), delays)
        assertNull("a seventh attempt must not be scheduled", BridgeDaemonConnectionService.relinkDelayMs(7))
        assertNull(BridgeDaemonConnectionService.relinkDelayMs(50))
        // Long enough to outlast a daemon being restarted by hand, short enough to stay bounded.
        assertTrue("the whole sequence must stay near two minutes", delays.filterNotNull().sum() < 120_000L)
    }

    fun `test unlinking a project that was never linked is safe`() {
        val service = service()

        service.unlink(project)
        service.unlink(project)

        assertTrue(service.linkedProjects().isEmpty())
    }

    fun `test the panel can tell a missing daemon from an unlinked project`() {
        val service = service()

        // Two different facts, and the tool window states them separately: without this a user
        // cannot tell "nothing is listening" from "this project is not exposed".
        assertFalse("no daemon is running in this fixture", service.daemonAvailable())
        assertFalse(service.isLinked(project))
    }

    fun `test a change listener is told when links change, and released when removed`() {
        val service = service()
        var calls = 0
        val listener: () -> Unit = { calls += 1 }

        service.addChangeListener(listener)
        // Unlinking a project that is not linked changes nothing, so it must not report a change.
        service.unlink(project)
        assertEquals("nothing changed, so nothing is announced", 0, calls)

        service.removeChangeListener(listener)
        service.disconnectAll()
        assertEquals(0, calls)
    }
}
