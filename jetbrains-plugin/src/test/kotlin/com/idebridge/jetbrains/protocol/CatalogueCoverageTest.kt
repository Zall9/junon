package com.idebridge.jetbrains.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Proves the Kotlin method catalogue is complete against the canonical schemas.
 *
 * The schemas in `packages/protocol/schemas/` are the source of truth (AGENTS.md §2). This test
 * extracts every `method` constant declared there and requires the Kotlin lists to match exactly —
 * so a method added to the protocol fails this build until the plugin acknowledges it, rather than
 * being silently unsupported.
 */
class CatalogueCoverageTest {
    private val schemaRoot = File(repositoryRoot(), "packages/protocol/schemas")

    /** Collects every `"method": { "const": "..." }` declared anywhere in a schema document. */
    private fun declaredMethods(directory: String): Set<String> {
        val found = mutableSetOf<String>()
        fun walk(element: kotlinx.serialization.json.JsonElement) {
            when (element) {
                is JsonObject -> {
                    val method = element["method"]
                    if (method is JsonObject) {
                        val constant = method["const"]
                        if (constant is JsonPrimitive && constant.isString) found.add(constant.content)
                    }
                    element.values.forEach(::walk)
                }
                is kotlinx.serialization.json.JsonArray -> element.forEach(::walk)
                else -> Unit
            }
        }
        File(schemaRoot, directory).listFiles()?.forEach { file ->
            walk(Json.parseToJsonElement(file.readText()))
        }
        return found
    }

    @Test
    fun `every schema method appears in the application catalogue`() {
        val declared = declaredMethods("method")
        assertEquals(
            declared.sorted(),
            APPLICATION_METHODS.sorted(),
            "Kotlin application methods drifted from the canonical method schemas",
        )
    }

    @Test
    fun `every schema notification appears in the notification catalogue`() {
        val declared = declaredMethods("notification")
        assertEquals(
            declared.sorted(),
            NOTIFICATION_METHODS.sorted(),
            "Kotlin notification methods drifted from the canonical notification schemas",
        )
    }

    @Test
    fun `role partitions are disjoint and cover the catalogue`() {
        val partitions =
            ADAPTER_ORIGINATED_METHODS + CONSUMER_LOCAL_METHODS + ROUTED_METHODS
        assertEquals(
            partitions.size,
            partitions.toSet().size,
            "a method appears in more than one role partition",
        )
        assertEquals(APPLICATION_METHODS.toSet(), partitions.toSet())
    }

    @Test
    fun `the plugin declares a handler surface for every routed method`() {
        // Routed methods are the ones the daemon forwards to this adapter. Any of them missing here
        // would mean a consumer request the plugin can never answer.
        assertTrue(ROUTED_METHODS.isNotEmpty())
        for (method in ROUTED_METHODS) {
            assertTrue(method in APPLICATION_METHODS, "$method is routed but not in the catalogue")
        }
    }

    companion object {
        /** The Gradle project directory is `jetbrains-plugin/`; the schemas live one level up. */
        fun repositoryRoot(): File = File(System.getProperty("user.dir")).parentFile
    }
}
