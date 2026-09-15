package com.idebridge.jetbrains.connection

import com.intellij.openapi.diagnostic.logger
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission

/**
 * Starts the daemon when there is none, from the command an installer wrote down.
 *
 * **The daemon was the half of this product that nobody owned.** This plugin only ever connected —
 * no process was started anywhere in it — and only the VS Code extension could spawn one. So a
 * daemon that died stayed dead: on 2026-09-15 one died when the disk filled, and an IDE sat beside
 * it for ninety minutes with the plugin loaded, both of them working perfectly and unable to meet.
 *
 * The command cannot be guessed here — this plugin has no idea where a built daemon lives — so it is
 * read from `~/.ide-bridge/daemon.json`, written by whichever installer put the plugin in place,
 * since that one is by definition running from a checkout that has built it.
 *
 * **That file names a program this plugin will execute, so it is treated as a credential** — the
 * same standard the discovery file's token already sets (SECURITY.md §3). A file owned by another
 * user, or writable by group or others, is refused and logged rather than run: what it names could
 * have been chosen by somebody else, and running it would make this a local privilege escalation.
 */
public object DaemonStarter {

    private val logger = logger<DaemonStarter>()

    /** Where the command is recorded. `IDE_BRIDGE_DAEMON_COMMAND_FILE` overrides it, for tests. */
    @JvmStatic
    public fun commandPath(): Path {
        val override = System.getenv("IDE_BRIDGE_DAEMON_COMMAND_FILE")
        if (!override.isNullOrBlank()) return Paths.get(override)
        return Paths.get(System.getProperty("user.home"), ".ide-bridge", "daemon.json")
    }

    /** What the file says, or why it will not be used. */
    public sealed interface Outcome {
        public data class Runnable(val argv: List<String>, val directory: String) : Outcome

        /** No file: an ordinary state on a machine that installed no daemon. */
        public data object Absent : Outcome

        public data class Refused(val reason: String) : Outcome
    }

    /**
     * Reads the recorded command, refusing anything it cannot vouch for.
     *
     * Parsed by hand rather than with a serializer: this runs before anything else in the link, the
     * document is three fields, and a dependency added here would be one loaded into every IDE for
     * the sake of a file most machines do not have.
     */
    @JvmStatic
    public fun read(path: Path = commandPath()): Outcome {
        if (!Files.exists(path)) return Outcome.Absent
        if (!Files.isRegularFile(path)) return Outcome.Refused("$path is not a regular file")

        val owner = runCatching { Files.getOwner(path)?.name }.getOrNull()
        val me = System.getProperty("user.name")
        if (owner != null && me != null && owner != me) {
            return Outcome.Refused("$path is owned by $owner, not by $me — refusing to run what it names")
        }
        val permissions = runCatching { Files.getPosixFilePermissions(path) }.getOrNull()
        if (permissions != null &&
            (permissions.contains(PosixFilePermission.GROUP_WRITE) ||
                permissions.contains(PosixFilePermission.OTHERS_WRITE))
        ) {
            return Outcome.Refused(
                "$path is writable by other users, so what it names could have been chosen by " +
                    "somebody else — refusing to run it. Fix with: chmod 600 $path",
            )
        }

        val text = runCatching { Files.readString(path) }.getOrElse {
            return Outcome.Refused("$path could not be read: ${it.message}")
        }
        val argv = stringsOf(text, "argv")
        val directory = stringOf(text, "directory")
        if (argv.isEmpty() || directory == null) {
            return Outcome.Refused("$path does not carry a command and a directory")
        }
        return Outcome.Runnable(argv, directory)
    }

    /**
     * Starts the recorded daemon and waits for it to publish, or says why it did not.
     *
     * Bounded: a daemon that has not published within [timeoutMs] is not one this link can use, and
     * waiting longer would hold a project's start-up hostage to a process that may never answer.
     */
    @JvmStatic
    @JvmOverloads
    public fun start(
        discoveryPath: Path,
        commandPath: Path = commandPath(),
        timeoutMs: Long = 20_000,
    ): Boolean {
        val outcome = read(commandPath)
        when (outcome) {
            is Outcome.Absent -> {
                logger.info("[IDE Bridge] no daemon is running and none is recorded at $commandPath")
                return false
            }
            is Outcome.Refused -> {
                logger.warn("[IDE Bridge] ${outcome.reason}")
                return false
            }
            is Outcome.Runnable -> Unit
        }

        val runnable = outcome as Outcome.Runnable
        val log = File(System.getProperty("user.home"), ".ide-bridge/daemon.log")
        logger.info("[IDE Bridge] no daemon is running; starting the recorded one: ${runnable.argv.joinToString(" ")}")
        val started = runCatching {
            ProcessBuilder(runnable.argv)
                .directory(File(runnable.directory))
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(log))
                .start()
        }.getOrElse {
            logger.warn("[IDE Bridge] the recorded daemon command could not be started: ${it.message}")
            return false
        }

        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (DiscoveryReader.read(discoveryPath) is DiscoveryReader.Outcome.Ready) {
                logger.info("[IDE Bridge] the daemon started (pid ${started.pid()}) and published its endpoint")
                return true
            }
            if (!started.isAlive) {
                logger.warn("[IDE Bridge] the daemon exited immediately; its output is in $log")
                return false
            }
            Thread.sleep(250)
        }
        logger.warn("[IDE Bridge] the daemon did not publish within ${timeoutMs}ms; its output is in $log")
        return false
    }

    private fun stringOf(json: String, key: String): String? =
        Regex("\"$key\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(json)?.groupValues?.get(1)?.unescape()

    private fun stringsOf(json: String, key: String): List<String> {
        val array = Regex("\"$key\"\\s*:\\s*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL)
            .find(json)?.groupValues?.get(1) ?: return emptyList()
        return Regex("\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(array).map { it.groupValues[1].unescape() }.toList()
    }

    private fun String.unescape(): String =
        replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n")
}
