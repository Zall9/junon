package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Position
import com.idebridge.jetbrains.protocol.Range
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.protocol.SymbolLocator
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Checks the Kotlin relocation rule against the same vectors the VS Code adapter is checked against.
 *
 * The rule exists in two languages and cannot be shared as code. Sharing the vectors is what keeps
 * the protocol from answering differently depending on the IDE (ADR-0025).
 */
class SymbolRelocationTest {
    private val vectorsFile = File(
        File(System.getProperty("user.dir")).parentFile,
        "packages/protocol/fixtures/vectors/symbol-relocation-vectors.json",
    )
    private val root = Json.parseToJsonElement(vectorsFile.readText()).jsonObject
    private val defaultDocumentUri = root["documentUri"]!!.jsonPrimitive.content

    private fun range(values: JsonElement): Range {
        val numbers = values.jsonArray.map { it.jsonPrimitive.content.toInt() }
        return Range(Position(numbers[0], numbers[1]), Position(numbers[2], numbers[3]))
    }

    private fun locator(entry: JsonElement): SymbolLocator {
        val record = entry.jsonObject
        val selectionRange = range(record["selectionRange"]!!)
        return SymbolLocator(
            documentUri = record["documentUri"]?.jsonPrimitive?.content ?: defaultDocumentUri,
            name = record["name"]!!.jsonPrimitive.content,
            kind = Json.decodeFromString(SymbolKind.serializer(), record["kind"]!!.toString()),
            containerName = record["containerName"]?.jsonPrimitive?.content,
            selectionRange = selectionRange,
            positionEncoding = PositionEncoding.UTF16,
            fingerprint = "sha256:" + "c".repeat(64),
        )
    }

    private fun draft(entry: JsonElement): SymbolRelocation.Draft {
        val record = entry.jsonObject
        val locator = locator(entry)
        return SymbolRelocation.Draft(
            locator = locator,
            range = record["range"]?.let { range(it) } ?: locator.selectionRange,
            children = record["children"]?.jsonArray?.map { draft(it) } ?: emptyList(),
        )
    }

    @Test
    fun `agrees with the shared vectors on every case`() {
        val vectors = root["vectors"]!!.jsonArray
        assertTrue(vectors.isNotEmpty(), "the shared vector file must not be empty")

        for (entry in vectors) {
            val vector = entry.jsonObject
            val why = vector["why"]!!.jsonPrimitive.content
            val outcome = SymbolRelocation.relocate(
                locator(vector["target"]!!),
                vector["current"]!!.jsonArray.map { draft(it) },
            )

            when (vector["expect"]!!.jsonPrimitive.content) {
                "resolved" -> {
                    assertTrue(outcome is SymbolRelocation.Outcome.Resolved, "$why -> $outcome")
                    assertEquals(
                        vector["resolvedSelectionStartLine"]!!.jsonPrimitive.content.toInt(),
                        outcome.draft.locator.selectionRange.start.line,
                        why,
                    )
                }
                "ambiguous" -> {
                    assertTrue(outcome is SymbolRelocation.Outcome.Ambiguous, "$why -> $outcome")
                    assertEquals(
                        vector["candidateCount"]!!.jsonPrimitive.content.toInt(),
                        outcome.candidates.size,
                        why,
                    )
                }
                else -> assertEquals(SymbolRelocation.Outcome.NotFound, outcome, why)
            }
        }
    }

    @Test
    fun `the shared vectors exercise every relocation outcome`() {
        val outcomes = root["vectors"]!!.jsonArray
            .map { it.jsonObject["expect"]!!.jsonPrimitive.content }
            .toSet()
        assertEquals(setOf("resolved", "not-found", "ambiguous"), outcomes)
    }
}
