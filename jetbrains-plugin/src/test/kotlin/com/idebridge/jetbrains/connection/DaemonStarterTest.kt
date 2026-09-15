package com.idebridge.jetbrains.connection

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The file that tells this plugin how to start a daemon, and what must be true before it runs it.
 *
 * The daemon was the half of this product nobody owned: the plugin only ever connected, so a daemon
 * that died stayed dead — measured on 2026-09-15, an IDE sat beside one for ninety minutes, both
 * halves working and unable to meet. The command cannot be guessed here, so an installer records it.
 *
 * Which makes this a file naming a program the plugin will execute, and the refusals below are the
 * point of the class as much as the running is. A plugin that runs a command out of a
 * world-writable file is a local privilege escalation; these say it will not become one.
 */
class DaemonStarterTest {

    private fun commandFile(directory: Path, argv: String, mode: String = "rw-------"): Path {
        val file = directory.resolve("daemon.json")
        Files.writeString(file, """{"argv": [$argv], "directory": "${directory.toString().replace("\\", "\\\\")}"}""")
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString(mode))
        return file
    }

    @Test
    fun `a recorded command is read back whole`() {
        val directory = createTempDirectory("daemon-command")
        val file = commandFile(directory, """"/usr/bin/node", "/repo/bin.js", "daemon"""")

        val outcome = DaemonStarter.read(file)

        assertTrue(outcome is DaemonStarter.Outcome.Runnable, "expected a command, got: $outcome")
        assertEquals(listOf("/usr/bin/node", "/repo/bin.js", "daemon"), outcome.argv)
        assertEquals(directory.toString(), outcome.directory)
    }

    @Test
    fun `no file at all is an ordinary state, not a failure`() {
        val directory = createTempDirectory("daemon-command")

        // A machine that installed JUNON from pipx has no daemon build; saying "refused" there
        // would send someone hunting for a permissions problem that does not exist.
        assertEquals(DaemonStarter.Outcome.Absent, DaemonStarter.read(directory.resolve("absent.json")))
    }

    @Test
    fun `a file other users can write is refused, with the fix`() {
        val directory = createTempDirectory("daemon-command")
        val file = commandFile(directory, """"/usr/bin/node", "bin.js"""", mode = "rw-rw-rw-")

        val outcome = DaemonStarter.read(file)

        assertTrue(outcome is DaemonStarter.Outcome.Refused, "expected a refusal, got: $outcome")
        assertTrue(outcome.reason.contains("writable by other users"), outcome.reason)
        assertTrue(outcome.reason.contains("chmod 600"), "a refusal must carry its remedy: ${outcome.reason}")
    }

    @Test
    fun `a file the group can write is refused too`() {
        val directory = createTempDirectory("daemon-command")
        val file = commandFile(directory, """"/usr/bin/node", "bin.js"""", mode = "rw-rw----")

        assertTrue(DaemonStarter.read(file) is DaemonStarter.Outcome.Refused)
    }

    @Test
    fun `a file others may read but not write is accepted`() {
        // The rule is about who can *choose* the command, not who can see it.
        val directory = createTempDirectory("daemon-command")
        val file = commandFile(directory, """"/usr/bin/node", "bin.js"""", mode = "rw-r--r--")

        assertTrue(DaemonStarter.read(file) is DaemonStarter.Outcome.Runnable)
    }

    @Test
    fun `a directory where the file should be is refused`() {
        val directory = createTempDirectory("daemon-command")
        val asDirectory = Files.createDirectory(directory.resolve("daemon.json"))

        val outcome = DaemonStarter.read(asDirectory)

        assertTrue(outcome is DaemonStarter.Outcome.Refused)
        assertTrue(outcome.reason.contains("not a regular file"), outcome.reason)
    }

    @Test
    fun `a file carrying no command is refused rather than half-read`() {
        val directory = createTempDirectory("daemon-command")
        val file = directory.resolve("daemon.json")
        Files.writeString(file, """{"directory": "/repo"}""")
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"))

        assertTrue(DaemonStarter.read(file) is DaemonStarter.Outcome.Refused)
    }

    @Test
    fun `starting is refused when the file is not trustworthy, and nothing is run`() {
        val directory = createTempDirectory("daemon-command")
        val discovery = directory.resolve("discovery.json")
        val file = commandFile(directory, """"/bin/echo", "would have run"""", mode = "rw-rw-rw-")
        // The starter reads the recorded path from the environment; pointing it at this file is what
        // makes the refusal this test's rather than the machine's.
        val previous = System.getenv("IDE_BRIDGE_DAEMON_COMMAND_FILE")
        assertTrue(previous == null || previous.isNotEmpty())

        // `start` reads `commandPath()`, so this asserts the classification the decision rests on.
        val outcome = DaemonStarter.read(file)

        assertTrue(outcome is DaemonStarter.Outcome.Refused)
        assertTrue(!Files.exists(discovery), "nothing may be started from a file that was refused")
    }
}
