package com.idebridge.jetbrains.ui

import java.nio.file.Files
import java.nio.file.Path
import junit.framework.TestCase
import kotlin.io.path.writeText

/**
 * Reading the dashboards a JUNON process announces.
 *
 * The entries are written by the Python side; this reads them. The format is fixed by
 * `junon/dashboard_registry.py`, and the fixtures below are copies of what it writes — if the two
 * drift, these fail rather than the tool window quietly offering nothing.
 *
 * Liveness is the point: an entry whose process is gone must not become a link, because a link to a
 * dead port is worse than an absent one.
 */
class JunonDashboardsTest : TestCase() {

    private lateinit var directory: Path

    override fun setUp() {
        super.setUp()
        directory = Files.createTempDirectory("junon-dashboards")
    }

    private fun write(name: String, content: String) {
        directory.resolve(name).writeText(content)
    }

    fun `test a live entry is offered`() {
        val self = ProcessHandle.current().pid()
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24283/dashboard/", "pid": $self, "project": "serena"}""",
        )

        val found = JunonDashboards.running(directory)

        assertEquals(1, found.size)
        assertEquals("http://127.0.0.1:24283/dashboard/", found[0].url)
        assertEquals("serena", found[0].project)
    }

    fun `test an entry whose process is gone is not offered`() {
        // A pid the kernel does not assign, so the entry is certainly stale.
        write("999999.json", """{"url": "http://127.0.0.1:24999/dashboard/", "pid": 999999}""")

        assertTrue(JunonDashboards.running(directory).isEmpty())
    }

    fun `test a damaged entry does not hide a good one`() {
        val self = ProcessHandle.current().pid()
        write("broken.json", "{not json")
        write("$self.json", """{"url": "http://127.0.0.1:24284/dashboard/", "pid": $self}""")

        val found = JunonDashboards.running(directory)

        assertEquals(1, found.size)
        assertEquals("http://127.0.0.1:24284/dashboard/", found[0].url)
    }

    fun `test a null project is read as absent rather than as the word null`() {
        val self = ProcessHandle.current().pid()
        write("$self.json", """{"url": "http://127.0.0.1:24282/dashboard/", "pid": $self, "project": null}""")

        assertNull(JunonDashboards.running(directory).single().project)
    }

    fun `test several instances are all offered`() {
        // Ordinary: one Serena per project, each with its own dashboard on its own port.
        val self = ProcessHandle.current().pid()
        val parent = ProcessHandle.current().parent().map { it.pid() }.orElse(self)
        write("$self.json", """{"url": "http://127.0.0.1:24282/dashboard/", "pid": $self}""")
        write("$parent.json", """{"url": "http://127.0.0.1:24283/dashboard/", "pid": $parent}""")

        assertEquals(if (parent == self) 1 else 2, JunonDashboards.running(directory).size)
    }

    fun `test an absent directory is not an error`() {
        assertTrue(JunonDashboards.running(directory.resolve("nothing-here")).isEmpty())
    }
}
