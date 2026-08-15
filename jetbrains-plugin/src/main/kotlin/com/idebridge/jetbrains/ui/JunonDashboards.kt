package com.idebridge.jetbrains.ui

import com.intellij.openapi.diagnostic.logger
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isDirectory
import kotlin.io.path.name
import kotlin.io.path.readText

/**
 * Running JUNON dashboards, as they announce themselves.
 *
 * The plugin knows the daemon and nothing else. Serena's dashboard chooses its port at start-up from
 * whatever is free, so it cannot be guessed — four were seen on one machine in one evening, on
 * 24282, 24283, 24284 and 24286. Each Serena process therefore writes an entry naming its own URL
 * and pid, and this reads them.
 *
 * A dashboard that stopped leaves its file behind, so the pid is checked before an address is
 * offered: sending someone to a dead port is worse than showing no link at all. Nothing here is
 * parsed with a JSON library on purpose — the file has four fields, and the plugin does not carry a
 * parser for this one use.
 */
internal object JunonDashboards {

    private val logger = logger<JunonDashboards>()

    internal const val DIRECTORY_ENV_VAR: String = "IDE_BRIDGE_DASHBOARD_DIR"

    internal data class Dashboard(val url: String, val pid: Long, val project: String?)

    internal fun directory(): Path {
        val override = System.getenv(DIRECTORY_ENV_VAR)
        if (!override.isNullOrBlank()) return Path.of(override)
        return Path.of(System.getProperty("user.home"), ".ide-bridge", "dashboards")
    }

    /** Every dashboard whose process is still running. Never throws; an unreadable entry is skipped. */
    internal fun running(from: Path = directory()): List<Dashboard> {
        if (!from.isDirectory()) return emptyList()
        return runCatching {
            Files.list(from).use { entries ->
                entries.toList()
                    .filter { it.name.endsWith(".json") }
                    .mapNotNull { parse(it) }
                    .filter { alive(it.pid) }
            }
        }.onFailure { logger.info("[IDE Bridge] could not read dashboard registry: $it") }
            .getOrDefault(emptyList())
    }

    private fun parse(path: Path): Dashboard? = runCatching {
        val text = path.readText()
        val url = field(text, "url") ?: return null
        val pid = field(text, "pid")?.toLongOrNull() ?: return null
        Dashboard(url = url, pid = pid, project = field(text, "project"))
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

    /** Whether the publishing process still exists. */
    private fun alive(pid: Long): Boolean =
        runCatching { ProcessHandle.of(pid).map { it.isAlive }.orElse(false) }.getOrDefault(false)
}
