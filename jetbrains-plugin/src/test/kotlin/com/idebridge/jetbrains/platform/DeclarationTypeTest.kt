package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.idebridge.jetbrains.symbol.SymbolRelocation
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The language-neutral discriminator, against real IDE parsers.
 *
 * Relocation used to lean on `kind` to tell two same-named declarations apart, and that stopped
 * working when every kind became `unknown`. `declarationType` replaced it: the IDE's own label for
 * a declaration's syntactic form, produced by every language's parser and never interpreted here.
 *
 * `PlatformSymbolKindMapper` has since made `kind` real again, so for Java a field and a method are
 * now distinguishable by kind alone. That does not make this redundant, and the tests below no
 * longer assert `unknown` as they once did — the point was never that kind is empty, but that
 * relocation must not depend on it. Kind is still coarse where a language is coarse (Kotlin answers
 * `class` for an enum class and its entries alike) and still absent where the IDE names two
 * categories at once (`constant field`). `declarationType` is derived from the parse tree and is
 * present either way.
 *
 * Both languages are exercised on purpose: whatever holds here must hold without any code naming
 * either of them.
 */
class DeclarationTypeTest : BasePlatformTestCase() {

    private fun drafts(fileName: String, source: String) = SymbolMapping.mapDocument(
        PsiSymbols.declarations(myFixture.configureByText(fileName, source)),
        "file:///demo/$fileName",
        LineIndex(source),
    )

    fun `test the IDE supplies a declaration type for every symbol`() {
        val service = drafts(
            "Service.java",
            """
            class Service {
                int value;

                int value() {
                    return value;
                }
            }
            """.trimIndent(),
        ).single()

        assertNotNull("the parser must label the declaration", service.locator.declarationType)
        for (child in service.children) {
            assertNotNull(child.locator.declarationType)
        }
    }

    fun `test a field and a method of the same name are distinguishable`() {
        val service = drafts(
            "Service.java",
            """
            class Service {
                int value;

                int value() {
                    return value;
                }
            }
            """.trimIndent(),
        ).single()

        val sameName = service.children.filter { it.locator.name == "value" }
        assertEquals("the fixture must contain both declarations", 2, sameName.size)
        // The label must separate them on its own. Asserting that kind is `unknown` here — as this
        // test used to — pinned a gap rather than a guarantee, and broke the moment the gap closed.
        assertTrue(
            "the parser's labels must differ: ${sameName.map { it.locator.declarationType }}",
            sameName[0].locator.declarationType != sameName[1].locator.declarationType,
        )
    }

    fun `test relocation picks the right one of two same-named declarations`() {
        val service = drafts(
            "Service.java",
            """
            class Service {
                int value;

                int value() {
                    return value;
                }
            }
            """.trimIndent(),
        ).single()

        val method = service.children.single {
            it.locator.name == "value" && it.locator.declarationType?.contains("METHOD") == true
        }
        val candidates = service.children.map {
            SymbolRelocation.Draft(it.locator, it.range, emptyList())
        }

        val outcome = SymbolRelocation.relocate(method.locator, candidates)

        // Without the discriminator this would be AMBIGUOUS_SYMBOL: two entries named `value`,
        // both `unknown`, and after an edit the range tie-break no longer applies either.
        val resolved = outcome as SymbolRelocation.Outcome.Resolved
        assertEquals(method.locator.declarationType, resolved.draft.locator.declarationType)
    }

    fun `test it works the same for a language the plugin knows nothing about`() {
        val service = drafts(
            "Service.kt",
            """
            class Service {
                val value = 1

                fun value() = value
            }
            """.trimIndent(),
        ).single()

        val sameName = service.children.filter { it.locator.name == "value" }
        assertEquals(2, sameName.size)
        // Kotlin, with no mapper and no code naming it anywhere: the same guarantee holds because
        // the label comes from Kotlin's own parser.
        assertTrue(
            "labels must differ: ${sameName.map { it.locator.declarationType }}",
            sameName[0].locator.declarationType != sameName[1].locator.declarationType,
        )
    }
}
