package com.idebridge.jetbrains.diagnostic

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.DiagnosticSeverity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DiagnosticMappingTest {
    private val text = "package demo;\n\nclass Service {\n    void run() {}\n}\n"
    private val index = LineIndex(text)

    private class TestHighlight(
        override val severityLevel: Int = DiagnosticMapping.ERROR_LEVEL,
        override val startOffset: Int = 0,
        override val endOffset: Int = 7,
        override val message: String? = "cannot resolve symbol",
        override val source: String? = "JavaCompiler",
        override val fixes: List<DiagnosticMapping.Fix> = emptyList(),
    ) : DiagnosticMapping.Highlight

    @Test
    fun `offers with no fixes omit the field rather than sending an empty list`() {
        // Omitting says nothing was offered here; `[]` would claim the adapter looked and the IDE
        // had nothing, which the daemon's conformance rules treat as a different statement.
        val mapping = DiagnosticMapping.map(listOf(TestHighlight()), index)

        assertNull(mapping.diagnostics.single().availableFixes)
    }

    @Test
    fun `publishes the IDE's own wording for each offered fix`() {
        val mapping = DiagnosticMapping.map(
            listOf(
                TestHighlight(
                    fixes = listOf(
                        DiagnosticMapping.Fix("family:Change type", "Change type to String"),
                    ),
                ),
            ),
            index,
        )

        val fixes = mapping.diagnostics.single().availableFixes
        assertEquals(1, fixes?.size)
        assertEquals("Change type to String", fixes?.single()?.title)
        assertEquals("family:Change type", fixes?.single()?.fixId)
    }

    @Test
    fun `maps a highlight to a diagnostic at the right position`() {
        val start = text.indexOf("Service")
        val mapping = DiagnosticMapping.map(
            listOf(TestHighlight(startOffset = start, endOffset = start + "Service".length)),
            index,
        )

        val diagnostic = mapping.diagnostics.single()
        assertEquals(DiagnosticSeverity.ERROR, diagnostic.severity)
        assertEquals("cannot resolve symbol", diagnostic.message)
        assertEquals("JavaCompiler", diagnostic.source)
        assertEquals(2, diagnostic.range.start.line)
        assertEquals("class ".length, diagnostic.range.start.character)
        assertFalse(mapping.truncated)
    }

    @Test
    fun `maps IntelliJ's numeric severity scale onto the protocol's four levels`() {
        assertEquals(DiagnosticSeverity.ERROR, DiagnosticMapping.severity(400))
        assertEquals(DiagnosticSeverity.WARNING, DiagnosticMapping.severity(300))
        assertEquals(DiagnosticSeverity.HINT, DiagnosticMapping.severity(200))
        assertEquals(DiagnosticSeverity.INFORMATION, DiagnosticMapping.severity(100))

        // The scale is open — plugins register their own severities — so a value above ERROR must
        // stay an error rather than fall through to the default.
        assertEquals(DiagnosticSeverity.ERROR, DiagnosticMapping.severity(10_000))
        assertEquals(DiagnosticSeverity.WARNING, DiagnosticMapping.severity(350))
        assertEquals(DiagnosticSeverity.INFORMATION, DiagnosticMapping.severity(0))
    }

    @Test
    fun `never emits a diagnostic code, since the platform assigns none`() {
        val diagnostic = DiagnosticMapping.map(listOf(TestHighlight()), index).diagnostics.single()

        // Reusing the inspection id as a code would present an internal identifier as if a
        // language service had assigned it.
        assertNull(diagnostic.code)
        assertNull(diagnostic.relatedInformation)
    }

    @Test
    fun `drops a highlight whose offsets no longer address the document`() {
        // The daemon runs asynchronously, so a highlight can outlive the text it was computed on.
        // Reporting it against the current snapshot would point the consumer at the wrong code.
        val mapping = DiagnosticMapping.map(
            listOf(TestHighlight(startOffset = text.length - 1, endOffset = text.length + 40)),
            index,
        )

        assertTrue(mapping.diagnostics.isEmpty())
        assertTrue(mapping.truncated, "an unrepresentable entry is a missing result")
    }

    @Test
    fun `drops a highlight with no message rather than emitting an empty one`() {
        val mapping = DiagnosticMapping.map(
            listOf(TestHighlight(message = null), TestHighlight(message = "   ")),
            index,
        )

        assertTrue(mapping.diagnostics.isEmpty())
        assertTrue(mapping.truncated)
    }

    @Test
    fun `drops an over-long message instead of cutting it`() {
        val long = "x".repeat(DiagnosticMapping.MAX_MESSAGE_LENGTH + 1)

        val mapping = DiagnosticMapping.map(listOf(TestHighlight(message = long)), index)

        // Cutting would change what the language service said while still presenting it as its
        // message.
        assertTrue(mapping.diagnostics.isEmpty())
        assertTrue(mapping.truncated)
    }

    @Test
    fun `bounds a document's diagnostics and says the result is incomplete`() {
        val many = (0..DiagnosticMapping.MAX_DIAGNOSTICS_PER_DOCUMENT).map { TestHighlight() }

        val mapping = DiagnosticMapping.map(many, index)

        assertEquals(DiagnosticMapping.MAX_DIAGNOSTICS_PER_DOCUMENT, mapping.diagnostics.size)
        assertTrue(mapping.truncated)
    }

    @Test
    fun `a clean document is complete, not truncated`() {
        val mapping = DiagnosticMapping.map(emptyList(), index)

        assertTrue(mapping.diagnostics.isEmpty())
        assertFalse(mapping.truncated, "no problems is a complete answer, not a missing one")
    }

    @Test
    fun `omits a blank source rather than reporting an empty producer`() {
        val diagnostic = DiagnosticMapping.map(listOf(TestHighlight(source = "  ")), index)
            .diagnostics
            .single()

        assertNull(diagnostic.source)
    }

    @Test
    fun `a document the IDE has not finished analysing is reported incomplete`() {
        // The platform answers with what it has already computed, so an unanalysed document yields
        // an empty list. Reporting that as complete would tell the consumer the file is clean.
        val pending = DiagnosticMapping.map(emptyList(), index, DiagnosticMapping.Analysis.PENDING)

        assertTrue(pending.diagnostics.isEmpty())
        assertTrue(pending.truncated, "absent problems prove nothing until analysis has run")
    }

    @Test
    fun `a pending document stays incomplete even when it already has problems`() {
        val pending = DiagnosticMapping.map(
            listOf(TestHighlight()),
            index,
            DiagnosticMapping.Analysis.PENDING,
        )

        assertEquals(1, pending.diagnostics.size)
        assertTrue(pending.truncated, "more problems may still appear")
    }

    @Test
    fun `a document the IDE never highlights is complete, not pending`() {
        // Nothing is being waited for here, so claiming incompleteness would make every such
        // document look permanently unanswered.
        val unavailable =
            DiagnosticMapping.map(emptyList(), index, DiagnosticMapping.Analysis.UNAVAILABLE)

        assertTrue(unavailable.diagnostics.isEmpty())
        assertFalse(unavailable.truncated)
    }
}
