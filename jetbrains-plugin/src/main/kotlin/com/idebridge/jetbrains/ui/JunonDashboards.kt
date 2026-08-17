package com.idebridge.jetbrains.ui

import com.intellij.openapi.diagnostic.logger
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isDirectory
import kotlin.io.path.name
import kotlin.io.path.readText
import kotlin.math.abs

/**
 * Running JUNON dashboards, as they announce themselves.
 *
 * The plugin knows the daemon and nothing else. Serena's dashboard chooses its port at start-up from
 * whatever is free, so it cannot be guessed — four were seen on one machine in one evening, on
 * 24282, 24283, 24284 and 24286. Each Serena process therefore writes an entry naming its own URL,
 * its pid and when it started, and this reads them.
 *
 * A dashboard that stopped leaves its file behind, so the entry is checked before an address is
 * offered: sending someone to a dead port is worse than showing no link at all. **The pid alone does
 * not do that check.** Pids are reused, and these files outlive their processes — fourteen were
 * found in one directory, three days old, every one of them dead. A pid-only reader calls such an
 * entry live the moment the kernel hands its number to something unrelated, and then offers a link
 * to a port that is not a dashboard, which is the exact outcome this is here to avoid. So the start
 * time is required to match as well: a pid can come round again, but not at the same instant.
 *
 * Nothing here is parsed with a JSON library on purpose — the file has five fields, and the plugin
 * does not carry a parser for this one use.
 */
internal object JunonDashboards {

    private val logger = logger<JunonDashboards>()

    internal const val DIRECTORY_ENV_VAR: String = "IDE_BRIDGE_DASHBOARD_DIR"

    /**
     * How far a recorded start time may sit from the live process's before they are two processes.
     *
     * Mirrors `_START_TIME_TOLERANCE_SECONDS` in `junon/dashboard_registry.py`; the two sides read
     * this file, so they have to agree. It is not zero because the writer and this reader ask
     * different plumbing for the same fact: psutil gives epoch seconds with microseconds on it, and
     * [ProcessHandle.Info.startInstant] gives whole milliseconds — measured on macOS as
     * 1786899750.370856 against 1786899750370, the same value truncated. On Linux both are rebuilt
     * from clock ticks plus a boot time known only to the second, which can disagree by more.
     * Requiring exact equality would therefore show no dashboards at all on some platforms, which is
     * the failure that looks like a broken plugin rather than like a stopped dashboard.
     */
    private const val START_TIME_TOLERANCE_SECONDS: Double = 2.0

    internal data class Dashboard(
        val url: String,
        val pid: Long,
        val project: String?,
        /**
         * When the kernel says this pid's process started, in epoch seconds, or `null` for an entry
         * written before the field existed.
         *
         * Not the same kind of thing as `Discovery.startedAt`, which the daemon writes about itself
         * as an ISO string. This one is read back out of the operating system, which is what lets a
         * reader use it to tell one process from another that inherited its number; a timestamp a
         * process chose for itself could not settle that question.
         */
        val startedAt: Double? = null,
    )

    internal fun directory(): Path {
        val override = System.getenv(DIRECTORY_ENV_VAR)
        if (!override.isNullOrBlank()) return Path.of(override)
        return Path.of(System.getProperty("user.home"), ".ide-bridge", "dashboards")
    }

    /**
     * Every dashboard still published by the process that published it. Never throws; an unreadable
     * entry is skipped.
     */
    internal fun running(from: Path = directory()): List<Dashboard> {
        if (!from.isDirectory()) return emptyList()
        return runCatching {
            Files.list(from).use { entries ->
                entries.toList()
                    .filter { it.name.endsWith(".json") }
                    .mapNotNull { parse(it) }
                    .filter { isThePublisher(it) }
            }
        }.onFailure { logger.info("[IDE Bridge] could not read dashboard registry: $it") }
            .getOrDefault(emptyList())
    }

    private fun parse(path: Path): Dashboard? = runCatching {
        val text = path.readText()
        val url = field(text, "url") ?: return null
        val pid = field(text, "pid")?.toLongOrNull() ?: return null
        Dashboard(
            url = url,
            pid = pid,
            project = field(text, "project"),
            startedAt = field(text, "started_at")?.toDoubleOrNull(),
        )
    }.getOrNull()

    /**
     * One field out of a flat JSON object.
     *
     * Handles the quoted and unquoted forms because `pid` is a number and `project` may be `null`;
     * anything more elaborate belongs in a parser, and anything that needs a parser does not belong
     * in this file.
     */
    private fun field(text: String, name: String): String? {
        val marker = "\"$name\":"
        val start = text.indexOf(marker).takeIf { it >= 0 }?.plus(marker.length) ?: return null
        val rest = text.substring(start).trimStart()
        if (rest.startsWith('"')) {
            val end = rest.indexOf('"', startIndex = 1).takeIf { it > 0 } ?: return null
            return rest.substring(1, end)
        }
        val end = rest.indexOfFirst { it == ',' || it == '}' }.takeIf { it > 0 } ?: return null
        return rest.substring(0, end).trim().takeUnless { it == "null" }
    }

    /**
     * Whether the process holding this entry's pid is the one that wrote it.
     *
     * An entry with no start time is accepted on its pid alone: it was written before the field
     * existed, and refusing those would empty this list for every JUNON already running at the
     * moment the user updates. A start time the JVM will not give up is accepted for the same
     * reason — it leaves the entry no less trustworthy than it was, and no more.
     */
    private fun isThePublisher(dashboard: Dashboard): Boolean = runCatching {
        val handle = ProcessHandle.of(dashboard.pid).orElse(null)
        when {
            handle == null || !handle.isAlive -> false
            dashboard.startedAt == null -> true
            else -> {
                val actual = handle.info().startInstant().orElse(null)
                actual == null ||
                    abs(actual.toEpochMilli() / 1000.0 - dashboard.startedAt) <=
                        START_TIME_TOLERANCE_SECONDS
            }
        }
    }.getOrDefault(false)
}
