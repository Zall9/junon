package com.idebridge.jetbrains.protocol

import kotlinx.serialization.json.Json

/**
 * The single JSON configuration used for every IDEBP message.
 *
 * The settings are not stylistic; each one enforces part of the wire contract:
 *
 * - `ignoreUnknownKeys = false` mirrors `additionalProperties: false`. A field this plugin does not
 *   model is a contract drift, and failing loudly is the point — the conformance suite relies on it.
 * - `explicitNulls = false` keeps optional fields absent rather than serialized as `null`. The
 *   schemas distinguish "absent" from "null"; encoding nulls would produce messages the daemon
 *   rejects. Optional fields are therefore modelled as nullable with a `null` default.
 * - `encodeDefaults = true` because required constants — `jsonrpc`, `method`, `type`, `kind` — are
 *   expressed as Kotlin defaults and must appear on the wire. Suppressing defaults dropped them,
 *   which the conformance round-trip caught immediately. Optionality is carried by nullability
 *   alone, never by a non-null default.
 *
 * Schemas in `packages/protocol/schemas/` remain canonical (AGENTS.md §2). These declarations are a
 * second expression of that contract, so `WireConformanceTest` round-trips every canonical fixture
 * through them and fails on any divergence.
 */
public val IdebpJson: Json = Json {
    ignoreUnknownKeys = false
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
    allowStructuredMapKeys = false
    prettyPrint = false
}
