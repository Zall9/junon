package com.idebridge.jetbrains.diagnostic

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.AvailableFix
import com.idebridge.jetbrains.protocol.Diagnostic
import com.idebridge.jetbrains.protocol.DiagnosticSeverity
import com.idebridge.jetbrains.protocol.PositionEncoding

/**
 * Maps IntelliJ highlights to IDEBP diagnostics.
 *
 * Free of platform types, so severity thresholds, bounds, and redaction are exercised without an
 * IDE; the platform-facing layer only has to describe each highlight as a [Highlight].
 *
 * **Redaction is a requirement, not a nicety** (AGENTS.md §2). A highlight carries a tooltip that
 * routinely embeds the offending source text, and an inspection can name a value it found. Only the
 * short description travels, and it is length-bounded; the tooltip is never read.
 */
public object DiagnosticMapping {
    /** Mirrors `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` in the protocol package. */
    public const val MAX_DIAGNOSTICS_PER_DOCUMENT: Int = 1_000

    /**
     * A message longer than this is dropped rather than cut. Truncating would change what the
     * language service said while still presenting it as its message.
     */
    public const val MAX_MESSAGE_LENGTH: Int = 2_048

    /**
     * IntelliJ severities are an open, numeric scale — plugins register their own — so the mapping
     * is by threshold rather than by name. The platform's own anchors are ERROR 400, WARNING 300,
     * WEAK_WARNING 200, INFORMATION 100.
     */
    public const val ERROR_LEVEL: Int = 400
    public const val WARNING_LEVEL: Int = 300
    public const val WEAK_WARNING_LEVEL: Int = 200

    /** One highlight, as the platform reports it. */
    public interface Highlight {
        public val severityLevel: Int
        public val startOffset: Int
        public val endOffset: Int

        /** The short description. Never the tooltip, which may embed source text. */
        public val message: String?

        /** The inspection or annotator that produced it, when the platform names one. */
        public val source: String?

        /**
         * Fixes the IDE offers here. Empty when it offers none.
         *
         * Published so a consumer can choose one; the adapter never chooses on its behalf, which
         * would be executing an IDE action nobody asked for.
         */
        public val fixes: List<Fix>
    }

    /** One offered fix: an opaque handle and the IDE's own wording, never interpreted here. */
    public data class Fix(val fixId: String, val title: String)

    public data class Mapping(val diagnostics: List<Diagnostic>, val truncated: Boolean)

    /**
     * How much the IDE has actually analysed the document.
     *
     * This exists because the platform answers a snapshot request with whatever it has **already**
     * computed. A document the daemon has never looked at yields an empty list, which a consumer
     * cannot tell apart from a clean file — so the state has to travel with the result.
     */
    public enum class Analysis {
        /** The daemon has finished this document; an empty list means it is clean. */
        COMPLETED,

        /** Analysis has not run or is still running: absent problems prove nothing. */
        PENDING,

        /** The IDE does not highlight this document at all, so there is nothing to wait for. */
        UNAVAILABLE,
    }

    /**
     * Maps a document's highlights.
     *
     * `truncated` says the document has problems this result does not carry — entries past the
     * bound, and entries that cannot be represented. It is deliberately not set for entries that
     * were merely below the severity floor: that is a scope decision made by the caller, not a
     * missing result, and conflating the two would make every clean document look incomplete.
     */
    public fun map(
        highlights: List<Highlight>,
        index: LineIndex,
        analysis: Analysis = Analysis.COMPLETED,
    ): Mapping {
        val diagnostics = mutableListOf<Diagnostic>()
        // A document the IDE has not finished analysing is reported as incomplete whatever it
        // currently holds. Answering `truncated = false` there would assert that these are all the
        // problems, which is precisely what is not known.
        var truncated = analysis == Analysis.PENDING

        for (highlight in highlights) {
            if (diagnostics.size >= MAX_DIAGNOSTICS_PER_DOCUMENT) {
                truncated = true
                break
            }
            val diagnostic = map(highlight, index)
            if (diagnostic == null) {
                truncated = true
                continue
            }
            diagnostics.add(diagnostic)
        }
        return Mapping(diagnostics, truncated)
    }

    /** Returns `null` for a highlight IDEBP cannot represent, which the caller counts as missing. */
    private fun map(highlight: Highlight, index: LineIndex): Diagnostic? {
        // A highlight whose offsets do not address this snapshot is stale: the document changed
        // under the analyser. Reporting it against the current text would point at the wrong code.
        if (!index.covers(highlight.startOffset, highlight.endOffset)) return null

        val message = highlight.message?.trim()
        if (message.isNullOrEmpty() || message.length > MAX_MESSAGE_LENGTH) return null

        return Diagnostic(
            range = index.range(highlight.startOffset, highlight.endOffset),
            positionEncoding = PositionEncoding.UTF16,
            severity = severity(highlight.severityLevel),
            message = message,
            source = highlight.source?.takeIf { it.isNotBlank() },
            // The platform has no diagnostic code, and inventing one from the inspection id would
            // present an internal identifier as if a language service had assigned it.
            code = null,
            // Omitted rather than sent empty: an empty list would claim the IDE offered nothing,
            // which is a different statement from this highlight carrying no offers to report.
            availableFixes = highlight.fixes
                .takeIf { it.isNotEmpty() }
                ?.map { AvailableFix(it.fixId, it.title) },
            relatedInformation = null,
        )
    }

    public fun severity(level: Int): DiagnosticSeverity = when {
        level >= ERROR_LEVEL -> DiagnosticSeverity.ERROR
        level >= WARNING_LEVEL -> DiagnosticSeverity.WARNING
        // A weak warning is IntelliJ's faint suggestion, which is what `hint` means here.
        level >= WEAK_WARNING_LEVEL -> DiagnosticSeverity.HINT
        else -> DiagnosticSeverity.INFORMATION
    }
}
