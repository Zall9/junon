package com.idebridge.jetbrains.workspace

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Checks the Kotlin containment rule against the same vectors the daemon is checked against.
 *
 * The two implementations exist in different languages and cannot share code. Sharing the vectors
 * is what keeps them from drifting: an adapter whose rule is looser than the daemon's returns URIs
 * the daemon rejects as a policy violation, costing the adapter its session (ADR-0025).
 */
class WorkspaceUriTest {
    private val vectorsFile = File(
        File(System.getProperty("user.dir")).parentFile,
        "packages/protocol/fixtures/vectors/uri-containment-vectors.json",
    )

    private data class Vector(
        val documentUri: String,
        val rootUri: String,
        val contained: Boolean,
        val why: String,
    )

    private fun vectors(): List<Vector> =
        Json.parseToJsonElement(vectorsFile.readText())
            .jsonObject["vectors"]!!
            .jsonArray
            .map { entry ->
                val record = entry.jsonObject
                Vector(
                    documentUri = record["documentUri"]!!.jsonPrimitive.content,
                    rootUri = record["rootUri"]!!.jsonPrimitive.content,
                    contained = record["contained"]!!.jsonPrimitive.content.toBoolean(),
                    why = record["why"]!!.jsonPrimitive.content,
                )
            }

    @Test
    fun `agrees with the daemon on every shared vector`() {
        val vectors = vectors()
        assertTrue(vectors.isNotEmpty(), "the shared vector file must not be empty")

        val disagreements = vectors.filter { vector ->
            WorkspaceUri.isWithinRoot(vector.documentUri, vector.rootUri) != vector.contained
        }
        assertTrue(
            disagreements.isEmpty(),
            "Kotlin containment diverged from the shared vectors: " +
                disagreements.joinToString { "${it.documentUri} in ${it.rootUri} (${it.why})" },
        )
    }

    @Test
    fun `the shared vectors exercise both outcomes`() {
        val vectors = vectors()
        assertTrue(vectors.any { it.contained }, "no positive case")
        assertTrue(vectors.any { !it.contained }, "no negative case")
    }

    @Test
    fun `a NUL byte in a decoded path fails closed`() {
        // Percent-encoded NUL is a classic path-truncation trick; it must never be accepted.
        assertEquals(
            false,
            WorkspaceUri.isWithinRoot(
                "file:///workspace/project/a%00.ts",
                "file:///workspace/project",
            ),
        )
    }
}
