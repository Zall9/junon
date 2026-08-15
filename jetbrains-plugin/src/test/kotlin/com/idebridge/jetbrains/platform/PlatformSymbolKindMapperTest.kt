package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.PlatformSymbolKindMapper
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The kinds the IDE actually supplies, against real parsers.
 *
 * Every assertion here is a claim about what the platform answers, not about a table this plugin
 * wrote — the mapper contains no per-language correspondence at all. Java and Kotlin are both
 * exercised because the point is that neither is named anywhere in the production code.
 *
 * The limits are asserted as deliberately as the successes. A test suite that only pinned what
 * works would let a later change quietly start guessing at the cases the IDE leaves ambiguous.
 */
class PlatformSymbolKindMapperTest : BasePlatformTestCase() {

    private val mapper = PlatformSymbolKindMapper()

    /**
     * Pairs rather than a map: a Java constructor carries its class's name, so keying by name drops
     * one of the two silently — which is how the first version of this test "found" a class
     * reported as a constructor.
     */
    private fun kinds(fileName: String, source: String): List<Pair<String, SymbolKind?>> {
        val file: PsiFile = myFixture.configureByText(fileName, source)
        return PsiTreeUtil.findChildrenOfType(file, PsiNameIdentifierOwner::class.java)
            .mapNotNull { element -> element.name?.let { it to mapper.kindOf(element) } }
    }

    private fun List<Pair<String, SymbolKind?>>.assertKind(name: String, expected: SymbolKind?) {
        assertTrue(
            "expected $name to be $expected, measured: ${filter { it.first == name }}",
            contains(name to expected),
        )
    }

    private fun java() = kinds(
        "Shapes.java",
        """
        interface Shape {}

        enum Colour { RED, GREEN }

        class Box<T> implements Shape {
            static final int LIMIT = 3;
            int size;

            Box() {}

            void use() {
                int local = 1;
            }
        }
        """.trimIndent(),
    )

    private fun kotlin() = kinds(
        "Shapes.kt",
        """
        interface Shape

        object Registry

        class Box<T> : Shape {
            val size = 1

            fun use() = size
        }
        """.trimIndent(),
    )

    fun `test it classifies what it used to report as unknown`() {
        val java = java()

        // Before this mapper existed every one of these was UNKNOWN, in every IDE, forever.
        java.assertKind("Shape", SymbolKind.INTERFACE)
        java.assertKind("Colour", SymbolKind.ENUM)
        java.assertKind("Box", SymbolKind.CLASS)
        java.assertKind("use", SymbolKind.METHOD)
        java.assertKind("size", SymbolKind.FIELD)
    }

    fun `test a constructor is told apart from the class it is named after`() {
        // Both are called `Box`. The IDE separates them and so, therefore, does this.
        java().assertKind("Box", SymbolKind.CONSTRUCTOR)
    }

    fun `test the same holds for a language the plugin names nowhere`() {
        val kotlin = kotlin()

        kotlin.assertKind("Shape", SymbolKind.INTERFACE)
        kotlin.assertKind("Registry", SymbolKind.OBJECT)
        kotlin.assertKind("Box", SymbolKind.CLASS)
        kotlin.assertKind("use", SymbolKind.FUNCTION)
        kotlin.assertKind("size", SymbolKind.PROPERTY)
    }

    fun `test a multi-word spelling of a single kind is understood`() {
        val java = java()

        // "enum constant" and "type parameter" each name exactly one word of the protocol's
        // vocabulary, with no second candidate to choose between.
        java.assertKind("RED", SymbolKind.ENUM_MEMBER)
        java.assertKind("T", SymbolKind.TYPE_PARAMETER)
        java.assertKind("local", SymbolKind.VARIABLE)
    }

    fun `test a phrase naming two kinds at once is left unclassified`() {
        // Java calls `static final int LIMIT` a "constant field": both `constant` and `field` are in
        // the vocabulary, and the IDE did not choose between them. Neither may this.
        java().assertKind("LIMIT", null)
    }

    fun `test the IDE's own coarseness is reported, not corrected`() {
        val entries = kinds(
            "Colour.kt",
            """
            enum class Colour { RED, GREEN }
            """.trimIndent(),
        )

        // Kotlin's provider answers `class` for an enum class and for its entries alike, where Java
        // distinguishes them. Reporting ENUM_MEMBER here would mean this plugin knowing better than
        // Kotlin about Kotlin, which is the one thing it must never do.
        entries.assertKind("Colour", SymbolKind.CLASS)
        entries.assertKind("RED", SymbolKind.CLASS)
    }

    fun `test an unrecognised answer degrades to the old behaviour`() {
        // Nothing in a properties file is a declaration the platform names, so nothing is claimed —
        // and `classify` then falls through to UNKNOWN exactly as it did before.
        val file = myFixture.configureByText("app.properties", "greeting=hello")

        for (element in PsiTreeUtil.findChildrenOfType(file, PsiNameIdentifierOwner::class.java)) {
            val kind = mapper.kindOf(element)
            assertTrue(
                "an unknown word must not be forced into the vocabulary: ${element.name} -> $kind",
                kind == null || kind != SymbolKind.UNKNOWN,
            )
        }
    }
}
