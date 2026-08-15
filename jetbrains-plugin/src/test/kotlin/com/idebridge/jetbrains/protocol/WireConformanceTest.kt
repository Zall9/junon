package com.idebridge.jetbrains.protocol

import java.io.File
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Round-trips the canonical protocol fixtures through the Kotlin DTOs.
 *
 * These declarations are a second expression of a contract whose source of truth is JSON Schema
 * (AGENTS.md §2), so drift is guarded here rather than assumed away: every valid fixture must
 * deserialize and re-serialize to exactly the same JSON. A field the plugin forgot fails on the
 * unknown key; a field it invents fails on the comparison.
 */
class WireConformanceTest {
    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile
    private val fixtureRoot = File(repositoryRoot, "packages/protocol/fixtures")
    private val manifest =
        Json.parseToJsonElement(File(fixtureRoot, "manifest.json").readText()).jsonObjectOrThrow()

    /**
     * Maps a canonical schema reference to the Kotlin serializer that must accept it.
     *
     * A fixture whose schema has no entry here fails the completeness test below, so adding a
     * fixture to the protocol forces a decision in this plugin instead of passing unnoticed.
     */
    private val serializers: Map<String, KSerializer<*>> = mapOf(
        "bridge/handshake-request.schema.json" to HandshakeRequest.serializer(),
        "bridge/handshake-response.schema.json" to HandshakeResponse.serializer(),
        "bridge/handshake-error-response.schema.json" to HandshakeErrorResponse.serializer(),
        "discovery/discovery-file.schema.json" to DiscoveryFile.serializer(),
        "error/error-response.schema.json" to ErrorResponse.serializer(),
        "method/lifecycle.schema.json#/\$defs/ideRegisterRequest" to
            Request.serializer(IdeRegisterParams.serializer()),
        "method/workspace.schema.json#/\$defs/workspaceListResponse" to
            Response.serializer(WorkspaceListResult.serializer()),
        "method/document.schema.json#/\$defs/documentReadResponse" to
            Response.serializer(DocumentContent.serializer()),
        "method/symbol.schema.json#/\$defs/symbolResolveAtResponse" to
            Response.serializer(SymbolResolveAtResult.serializer()),
        "method/symbol.schema.json#/\$defs/workspaceSearchSymbolsRequest" to
            Request.serializer(WorkspaceSearchSymbolsParams.serializer()),
        "method/symbol.schema.json#/\$defs/workspaceSearchSymbolsResponse" to
            Response.serializer(WorkspaceSearchSymbolsResult.serializer()),
        "method/symbol.schema.json#/\$defs/symbolGetReferencesResponse" to
            Response.serializer(SymbolLocationsResult.serializer()),
        "method/edit.schema.json#/\$defs/refactorPrepareRequest" to
            Request.serializer(RefactorPrepareParams.serializer()),
        "method/edit.schema.json#/\$defs/refactorPrepareResponse" to
            Response.serializer(RefactorPrepareResult.serializer()),
        "method/edit.schema.json#/\$defs/refactorPrepareRenameResponse" to
            Response.serializer(RefactorPrepareRenameResult.serializer()),
        "method/diagnostics.schema.json#/\$defs/diagnosticsGetSnapshotResponse" to
            Response.serializer(DiagnosticsGetSnapshotResult.serializer()),
        "notification/cancel-request.schema.json" to
            Notification.serializer(CancelRequestParams.serializer()),
        "notification/events.schema.json#/\$defs/documentChanged" to
            Notification.serializer(DocumentEventParams.serializer()),
        // The four the adapter began sending on 2026-08-15. Adding their fixtures is what revealed
        // that nothing had ever confronted these Kotlin classes with the schema: they existed,
        // unverified, and a payload the daemon rejects closes the adapter's session — so the first
        // file a user opened would have taken the bridge down with it.
        "notification/events.schema.json#/\$defs/documentOpened" to
            Notification.serializer(DocumentEventParams.serializer()),
        "notification/events.schema.json#/\$defs/documentSaved" to
            Notification.serializer(DocumentEventParams.serializer()),
        "notification/events.schema.json#/\$defs/documentClosed" to
            Notification.serializer(DocumentEventParams.serializer()),
        "notification/events.schema.json#/\$defs/documentRenamed" to
            Notification.serializer(DocumentRenamedParams.serializer()),
        "notification/events.schema.json#/\$defs/diagnosticsChanged" to
            Notification.serializer(DiagnosticsChangedParams.serializer()),
        "notification/events.schema.json#/\$defs/documentDeleted" to
            Notification.serializer(DocumentDeletedParams.serializer()),
        "notification/events.schema.json#/\$defs/workspaceTrustChanged" to
            Notification.serializer(WorkspaceTrustChangedParams.serializer()),
    )

    /**
     * Invalid fixtures whose violation is a value constraint — a range, a length, a pattern — or a
     * discriminated invariant on error details, rather than a shape. A deserializer cannot and
     * should not reject these; the daemon and the Ajv layer do.
     *
     * The list is deliberately minimal: a fixture that omits a required field belongs in the
     * structural test, and putting it here would quietly weaken that test. Listing exclusions
     * explicitly means a new invalid fixture fails until someone classifies it.
     */
    private val constraintOnlyInvalidFixtures = setOf(
        "bridge/handshake/request-unsafe-id.invalid.json",
        "bridge/handshake/request-long-id.invalid.json",
        "bridge/handshake/request-long-version.invalid.json",
        "discovery/public-endpoint.invalid.json",
        "discovery/out-of-range-port.invalid.json",
        "mvp/search-symbols-query-too-long.invalid.json",
        "mvp/index-not-ready-not-retryable.invalid.json",
        "mvp/stale-document-missing-current-revision.invalid.json",
        "mvp/ambiguous-symbol-missing-candidates.invalid.json",
        "mvp/partial-apply-missing-documents.invalid.json",
    )

    private fun fixtures(): List<Triple<String, String, Boolean>> =
        manifest["fixtures"]!!.jsonArrayOrThrow().map { entry ->
            val record = entry.jsonObjectOrThrow()
            Triple(
                record["path"]!!.contentOrThrow(),
                record["schema"]!!.contentOrThrow().substringAfter("/0.1.0/"),
                record["valid"]!!.booleanOrThrow(),
            )
        }

    /** Fixtures under these roots are testing artifacts, not wire messages. */
    private fun isWireFixture(path: String): Boolean =
        !path.startsWith("languages/") && !path.startsWith("schemas/")

    @Test
    fun `every wire fixture schema has a Kotlin serializer`() {
        val unmapped = fixtures()
            .filter { (path, _, _) -> isWireFixture(path) }
            .map { (_, schema, _) -> schema }
            .distinct()
            .filter { it !in serializers }
        assertTrue(
            unmapped.isEmpty(),
            "no Kotlin serializer is declared for: ${unmapped.joinToString()}",
        )
    }

    @Test
    fun `valid fixtures round-trip without changing their wire shape`() {
        var checked = 0
        for ((path, schema, valid) in fixtures()) {
            if (!valid || !isWireFixture(path)) continue
            val serializer = serializers.getValue(schema)
            val original = File(fixtureRoot, path).readText()
            val decoded = IdebpJson.decodeFromString(serializer, original)

            @Suppress("UNCHECKED_CAST")
            val reencoded = IdebpJson.encodeToString(serializer as KSerializer<Any?>, decoded)
            assertEquals(
                Json.parseToJsonElement(original),
                Json.parseToJsonElement(reencoded),
                "round-trip changed the wire shape of $path",
            )
            checked += 1
        }
        assertTrue(checked >= 10, "expected the wire fixture set to be non-trivial, saw $checked")
    }

    @Test
    fun `structurally invalid fixtures are rejected`() {
        var rejected = 0
        for ((path, schema, valid) in fixtures()) {
            if (valid || !isWireFixture(path)) continue
            if (path in constraintOnlyInvalidFixtures) continue
            val serializer = serializers.getValue(schema)
            val text = File(fixtureRoot, path).readText()
            assertFailsWith<Exception>("$path should not deserialize") {
                IdebpJson.decodeFromString(serializer, text)
            }
            rejected += 1
        }
        assertTrue(rejected > 0, "no structurally invalid fixture was exercised")
    }

    @Test
    fun `constraint-only fixtures are all real fixtures`() {
        val known = fixtures().map { (path, _, _) -> path }.toSet()
        val stale = constraintOnlyInvalidFixtures.filter { it !in known }
        assertTrue(stale.isEmpty(), "these exclusions no longer match any fixture: $stale")
    }
}

private fun JsonElement.jsonObjectOrThrow(): JsonObject =
    this as? JsonObject ?: error("expected a JSON object")

private fun JsonElement.jsonArrayOrThrow(): kotlinx.serialization.json.JsonArray =
    this as? kotlinx.serialization.json.JsonArray ?: error("expected a JSON array")

private fun JsonElement.contentOrThrow(): String =
    (this as kotlinx.serialization.json.JsonPrimitive).content

private fun JsonElement.booleanOrThrow(): Boolean =
    (this as kotlinx.serialization.json.JsonPrimitive).content.toBoolean()
