package com.idebridge.jetbrains.service

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The version this plugin announces is the repository's, and it is a number an IDE can order.
 *
 * Two things were wrong at once. The constant said `0.1.0` while Gradle built `0.1.0-SNAPSHOT`, so
 * the plugin told the daemon one thing and the artifact was named another; and a `-SNAPSHOT` suffix
 * makes "is there a newer one" unanswerable for the JetBrains update mechanism, which decides by
 * comparing this string. A plugin distributed as a zip has no update path at all — the first step
 * out of that is a version worth comparing.
 */
class PluginVersionTest {

    private val repositoryVersion: String by lazy {
        var directory = File(System.getProperty("user.dir"))
        while (!File(directory, "VERSION").isFile) {
            directory = directory.parentFile ?: error("no VERSION file above ${System.getProperty("user.dir")}")
        }
        File(directory, "VERSION").readText().trim()
    }

    @Test
    fun `the version announced to the daemon is the repository's`() {
        assertEquals(repositoryVersion, BridgeDaemonConnectionService.PLUGIN_VERSION)
    }

    @Test
    fun `the version Gradle builds is the same one`() {
        var directory = File(System.getProperty("user.dir"))
        while (!File(directory, "gradle.properties").isFile) {
            directory = directory.parentFile ?: error("no gradle.properties found")
        }
        val declared = File(directory, "gradle.properties").readLines()
            .first { it.startsWith("pluginVersion=") }
            .substringAfter("=")
            .trim()

        assertEquals(repositoryVersion, declared)
    }

    @Test
    fun `it carries no suffix an update check cannot order`() {
        assertTrue(
            Regex("""^\d+\.\d+\.\d+$""").matches(repositoryVersion),
            "an IDE compares this string to decide whether an update exists: $repositoryVersion",
        )
    }
}
