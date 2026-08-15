package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

@Serializable
public enum class DiagnosticSeverity {
    @SerialName("error")
    ERROR,

    @SerialName("warning")
    WARNING,

    @SerialName("information")
    INFORMATION,

    @SerialName("hint")
    HINT,
}

@Serializable
public data class RelatedInformation(val location: Location, val message: String)

/**
 * `code` is `string | integer` on the wire. It is kept as a `JsonPrimitive` rather than collapsed
 * to a string: rewriting an integer code as text would change what the language service reported.
 */
@Serializable
public data class Diagnostic(
    val range: Range,
    val positionEncoding: PositionEncoding,
    val severity: DiagnosticSeverity,
    val message: String,
    val source: String? = null,
    val code: JsonPrimitive? = null,
    val relatedInformation: List<RelatedInformation>? = null,
    /** Null when the adapter did not look; a non-empty list when the IDE offered something. */
    val availableFixes: List<AvailableFix>? = null,
)

/** An offer, not a command: [fixId] is a handle the consumer passes back. */
@Serializable
public data class AvailableFix(val fixId: String, val title: String)

@Serializable
public data class DocumentDiagnostics(
    val document: DocumentReference,
    val diagnostics: List<Diagnostic>,
)
