package com.idebridge.jetbrains.ui

import java.nio.file.Files
import java.nio.file.Path
import junit.framework.TestCase
import kotlin.io.path.writeText

/**
 * Reading the dashboards a JUNON process announces.
 *
 * The entries are written by the Python side; this reads them. The format is fixed by
 * `junon/dashboard_registry.py`, and the fixtures below are copies of what it writes — a real one,
 * for reference, is
 * `{"url": "http://127.0.0.1:24283/dashboard/", "pid": 32936, "project": "serena", "started_at": 1786900074.876625}`.
 * If the two drift, these fail rather than the tool window quietly offering nothing.
 *
 * Liveness is the point: an entry whose process is gone must not become a link, because a link to a
 * dead port is worse than an absent one. And a pid is not a process — it is a number the kernel
 * lends out and later takes back — so the entries that matter most here are the ones whose pid is
 * alive and whose start time says it belongs to somebody else.
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

    private fun startMillis(pid: Long): Long =
        ProcessHandle.of(pid).orElseThrow().info().startInstant().orElseThrow().toEpochMilli()

    /**
     * This pid's start time written the way the Python side writes it: epoch seconds, plain
     * decimal.
     *
     * Built by hand rather than by interpolating a `Double`, which Kotlin renders as `1.7869E9` for
     * numbers this size. `toDoubleOrNull` would read that back happily, so the test would pass
     * while the fixture stopped resembling anything `json.dumps` has ever produced — and these
     * fixtures are only worth having while they are copies of the real thing.
     *
     * [shiftSeconds] moves the recorded time away from the truth, which is how an entry left by a
     * process that no longer holds this pid is staged.
     */
    private fun startedAt(pid: Long, shiftSeconds: Long = 0L): String {
        val millis = startMillis(pid) + shiftSeconds * 1000
        return "${millis / 1000}.${(millis % 1000).toString().padStart(3, '0')}"
    }

    fun `test a live entry is offered`() {
        val self = ProcessHandle.current().pid()
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24283/dashboard/", "pid": $self, "project": "serena", "started_at": ${startedAt(self)}}""",
        )

        val found = JunonDashboards.running(directory)

        assertEquals(1, found.size)
        assertEquals("http://127.0.0.1:24283/dashboard/", found[0].url)
        assertEquals("serena", found[0].project)
        assertEquals(startMillis(self) / 1000.0, found[0].startedAt!!, 0.0005)
    }

    fun `test an entry whose process is gone is not offered`() {
        // A pid the kernel does not assign, so the entry is certainly stale.
        write("999999.json", """{"url": "http://127.0.0.1:24999/dashboard/", "pid": 999999, "project": null, "started_at": 1786900074.876625}""")

        assertTrue(JunonDashboards.running(directory).isEmpty())
    }

    fun `test an entry whose pid was recycled is not offered`() {
        // The pid is alive — it is this test's own process — but it did not write this entry. That
        // is what a reused pid looks like from here, and the pid on its own cannot tell the
        // difference. Fourteen entries sat in the real directory for three days waiting for their
        // numbers to come round; each would have become a link to a port that is not a dashboard.
        val self = ProcessHandle.current().pid()
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24999/dashboard/", "pid": $self, "project": "serena", "started_at": ${startedAt(self, -3600)}}""",
        )

        assertTrue(JunonDashboards.running(directory).isEmpty())
    }

    fun `test a start time within tolerance is still the same process`() {
        // psutil writes microseconds, ProcessHandle reports whole milliseconds, and Linux rebuilds
        // both from clock ticks plus a boot time known to the second. Demanding exact equality
        // would offer nothing at all on some platforms — which reads as a broken plugin, not as a
        // stopped dashboard.
        val self = ProcessHandle.current().pid()
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24282/dashboard/", "pid": $self, "project": null, "started_at": ${startedAt(self, 1)}}""",
        )

        assertEquals(1, JunonDashboards.running(directory).size)
    }

    fun `test an entry written before start times were recorded is offered`() {
        // Updating the plugin must not empty the tool window for every JUNON already running.
        val self = ProcessHandle.current().pid()
        write("$self.json", """{"url": "http://127.0.0.1:24283/dashboard/", "pid": $self, "project": null}""")

        val found = JunonDashboards.running(directory)

        assertEquals(1, found.size)
        assertNull(found[0].startedAt)
    }

    fun `test a damaged entry does not hide a good one`() {
        val self = ProcessHandle.current().pid()
        write("broken.json", "{not json")
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24284/dashboard/", "pid": $self, "project": null, "started_at": ${startedAt(self)}}""",
        )

        val found = JunonDashboards.running(directory)

        assertEquals(1, found.size)
        assertEquals("http://127.0.0.1:24284/dashboard/", found[0].url)
    }

    fun `test a null project is read as absent rather than as the word null`() {
        val self = ProcessHandle.current().pid()
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24282/dashboard/", "pid": $self, "project": null, "started_at": ${startedAt(self)}}""",
        )

        assertNull(JunonDashboards.running(directory).single().project)
    }

    fun `test several instances are all offered`() {
        // Ordinary: one Serena per project, each with its own dashboard on its own port.
        val self = ProcessHandle.current().pid()
        val parent = ProcessHandle.current().parent().map { it.pid() }.orElse(self)
        write(
            "$self.json",
            """{"url": "http://127.0.0.1:24282/dashboard/", "pid": $self, "project": null, "started_at": ${startedAt(self)}}""",
        )
        write(
            "$parent.json",
            """{"url": "http://127.0.0.1:24283/dashboard/", "pid": $parent, "project": null, "started_at": ${startedAt(parent)}}""",
        )

        assertEquals(if (parent == self) 1 else 2, JunonDashboards.running(directory).size)
    }

    fun `test an absent directory is not an error`() {
        assertTrue(JunonDashboards.running(directory.resolve("nothing-here")).isEmpty())
    }
}
