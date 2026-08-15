package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.DiagnosticSeverity
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises the diagnostic read against the real daemon.
 *
 * The mapping rules are covered without the platform in `DiagnosticMappingTest`. What only a real
 * project can answer is whether the highlights come back at all, whether their severities land on
 * the protocol's levels, and — the part that matters most — whether the message that travels is the
 * short description rather than the tooltip, which embeds source text.
 */
class IntelliJDiagnosticsTest : BasePlatformTestCase() {

    private fun diagnose(fileName: String, source: String): DiagnosticMapping.Mapping {
        myFixture.configureByText(fileName, source)
        // Runs the daemon to completion, so the highlights read below are the ones the IDE shows.
        myFixture.doHighlighting()
        val document = myFixture.getDocument(myFixture.file)
        return DiagnosticMapping.map(
            IntelliJDiagnostics.highlights(project, document),
            LineIndex(document.charsSequence),
        )
    }

    fun `test reports a real compilation error with its position`() {
        val mapping = diagnose(
            "Broken.java",
            """
            class Broken {
                int value = "not an int";
            }
            """.trimIndent(),
        )

        val errors = mapping.diagnostics.filter { it.severity == DiagnosticSeverity.ERROR }
        assertFalse("the daemon must report the type mismatch", errors.isEmpty())

        val error = errors.first()
        assertEquals("the error is on the second line", 1, error.range.start.line)
        assertTrue("a diagnostic must carry a message", error.message.isNotBlank())
        assertTrue(
            "the range must be within the line it points at",
            error.range.end.line >= error.range.start.line,
        )
    }

    fun `test the message carries no source text`() {
        val secret = "correctHorseBatteryStaple"
        val mapping = diagnose(
            "Leaky.java",
            """
            class Leaky {
                int $secret = "not an int";
            }
            """.trimIndent(),
        )

        // The tooltip for this error embeds the offending expression. Reading it instead of the
        // description would put file content into a diagnostic, which AGENTS.md §2 forbids.
        for (diagnostic in mapping.diagnostics) {
            assertFalse(
                "a diagnostic message must not repeat the source it points at: ${diagnostic.message}",
                diagnostic.message.contains("not an int"),
            )
            assertFalse(
                "a diagnostic message must not carry HTML markup from a tooltip",
                diagnostic.message.contains("<html") || diagnostic.message.contains("<body"),
            )
        }
    }

    fun `test a clean file reports no problems and is not truncated`() {
        val mapping = diagnose(
            "Clean.java",
            """
            class Clean {
                int value = 1;

                int value() {
                    return value;
                }
            }
            """.trimIndent(),
        )

        assertTrue(
            "a valid file must produce no errors, got: ${mapping.diagnostics.map { it.message }}",
            mapping.diagnostics.none { it.severity == DiagnosticSeverity.ERROR },
        )
        assertFalse("no problems is a complete answer", mapping.truncated)
    }

    fun `test severities below a warning are excluded, so this is not syntax colouring`() {
        // The daemon emits an INFORMATION-level highlight for essentially every token. If the
        // severity floor were not applied at the source, a clean file would return hundreds of
        // "diagnostics" that are really syntax highlighting.
        val mapping = diagnose(
            "Clean.java",
            """
            class Clean {
                int value = 1;
            }
            """.trimIndent(),
        )

        assertTrue(
            "a two-line clean file must not produce a flood of entries: ${mapping.diagnostics.size}",
            mapping.diagnostics.size < 10,
        )
        assertTrue(
            "nothing below a hint may appear",
            mapping.diagnostics.none { it.severity == DiagnosticSeverity.INFORMATION },
        )
    }
}
