package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolHandleRegistry
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The promise that the adapter serves whatever the host IDE can parse.
 *
 * Kotlin is the case that proves it here: this IDE ships Kotlin support, so its PSI hands back named
 * declarations from a language the plugin names nowhere in its production code.
 *
 * This file used to explain the `unknown` kinds it asserted by saying the plugin "contributes a
 * mapper only for Java". That was never true — no mapper was contributed for any language, which is
 * why every kind was unknown everywhere. The single mapper that now exists is language-neutral, so
 * Kotlin classifies exactly as Java does, and the guarantee this file protects has to be stated
 * against something genuinely unclassifiable instead. A companion object is that case: Kotlin calls
 * it a "companion object", naming two vocabulary words at once, so its kind is left alone.
 *
 * It turned out to be a second case as well, and a worse one. The language names a companion
 * (`Companion`) without any text spelling that name, and until 2026-08-09 a declaration with no name
 * identifier was skipped along with everything inside it — so the factory functions and constants
 * companions routinely hold came back as nothing at all, with no refusal to explain the silence. The
 * tests below hold both halves: the row is reported because Kotlin names it, its kind stays unknown
 * because Kotlin names two kinds at once, and its members are reported because the row's own
 * unnameability was never a statement about them.
 *
 * That is the shape of what CLion or PhpStorm produce for C++ or PHP: navigation, ranges and rename
 * work throughout, and whatever the language declines to name plainly stays unknown.
 */
class OtherLanguageSymbolsTest : BasePlatformTestCase() {

    private val plain = """
        class Service {
            fun run() {}
        }
    """.trimIndent()

    private val companion = """
        class Service {
            companion object {
                const val NAME = "n"
                fun run() {}
            }
        }
    """.trimIndent()

    private fun drafts(source: String): List<SymbolHandleRegistry.Draft<PsiAnchor>> {
        val file = myFixture.configureByText("Service.kt", source)
        return SymbolMapping.mapDocument(
            PsiSymbols.declarations(file),
            "file:///demo/Service.kt",
            LineIndex(file.text),
        )
    }

    private fun everything(
        drafts: List<SymbolHandleRegistry.Draft<PsiAnchor>>,
    ): List<Pair<String, SymbolKind>> = buildList {
        fun collect(draft: SymbolHandleRegistry.Draft<PsiAnchor>) {
            add(draft.locator.name to draft.locator.kind)
            draft.children.forEach(::collect)
        }
        drafts.forEach(::collect)
    }

    /** Reads each reported name back out of the source at the position claimed for it. */
    private fun assertIdentifiersReadBack(
        source: String,
        draft: SymbolHandleRegistry.Draft<PsiAnchor>,
    ) {
        val lines = source.split("\n")
        val selection = draft.locator.selectionRange
        assertEquals(
            draft.locator.name,
            lines[selection.start.line].substring(
                selection.start.character,
                selection.end.character,
            ),
        )
        draft.children.forEach { assertIdentifiersReadBack(source, it) }
    }

    fun `test a language with no registered mapper still yields its declarations`() {
        val names = everything(drafts(plain)).map { it.first }

        // The whole point: an IDE the plugin was never taught about still produces symbols.
        assertTrue("Kotlin declarations must be found, got: $names", names.contains("Service"))
        assertTrue("nested declarations too, got: $names", names.contains("run"))
    }

    fun `test kinds arrive for a language the plugin names nowhere`() {
        val measured = everything(drafts(plain))

        // Kotlin's own words, taken as given. No production code names Kotlin anywhere; these
        // arrive because the platform asked Kotlin's provider and it answered `class` and
        // `function`. The refusal side of this — what happens when a language names two kinds at
        // once — is pinned in PlatformSymbolKindMapperTest and StructureViewSymbolsTest, where the
        // unclassifiable declarations survive the structure model.
        assertTrue("measured: $measured", measured.contains("Service" to SymbolKind.CLASS))
        assertTrue("measured: $measured", measured.contains("run" to SymbolKind.FUNCTION))
    }

    fun `test the identifier range is still usable without a kind`() {
        // An unknown kind must not cost a consumer navigation or rename: the selection range still
        // has to land on the identifier it names.
        drafts(plain).forEach { assertIdentifiersReadBack(plain, it) }
    }

    fun `test a declaration the language names without spelling keeps its members`() {
        val service = drafts(companion).single()
        val declared = service.children.single()

        // Kotlin supplies this name; the plugin does not invent it, and it is not the row's
        // presentation text either.
        assertEquals("Companion", declared.locator.name)
        // Two vocabulary words at once ("companion object"), so the kind is still left alone — the
        // same refusal as before this declaration became reportable.
        assertEquals(SymbolKind.UNKNOWN, declared.locator.kind)

        // The members are the reason this matters. A consumer asking a Kotlin file for its symbols
        // is usually asking for exactly these.
        assertEquals(listOf("NAME", "run"), declared.children.map { it.locator.name })
        for (member in declared.children) {
            assertEquals("Companion", member.locator.containerName)
        }
        assertEquals(
            "the members' own kinds are unaffected",
            listOf(SymbolKind.PROPERTY, SymbolKind.FUNCTION),
            declared.children.map { it.locator.kind },
        )
    }

    fun `test a name the text never spells claims no text as its own`() {
        val declared = drafts(companion).single().children.single()
        val selection = declared.locator.selectionRange

        // There is no identifier to point at, so nothing is pointed at: an empty range locates the
        // declaration without claiming that any text is its name. `IntelliJRename` refuses such an
        // element, so no consumer is invited to rewrite this span.
        assertEquals("nothing is claimed as the identifier", selection.start, selection.end)

        // It still has to locate the declaration it belongs to, which is what the protocol requires
        // of a selection range and what the mapping would otherwise reject the whole document for.
        val declaration = declared.range
        assertTrue(
            "the empty selection must sit inside the declaration, got $selection in $declaration",
            declaration.start.line < selection.start.line ||
                declaration.start.line == selection.start.line &&
                declaration.start.character <= selection.start.character,
        )
        assertTrue(
            "the empty selection must sit inside the declaration, got $selection in $declaration",
            selection.end.line < declaration.end.line ||
                selection.end.line == declaration.end.line &&
                selection.end.character <= declaration.end.character,
        )

        // The members keep real identifier ranges: the unspellable name costs them nothing.
        declared.children.forEach { assertIdentifiersReadBack(companion, it) }
    }

    fun `test a declaration with no name at all does not take its members with it`() {
        val source = """
            class Service {
                val task = object : Runnable {
                    override fun run() {}
                }
            }
        """.trimIndent()

        val names = everything(drafts(source)).map { it.first }

        // Kotlin's structure model lists the anonymous object, and the language gives it no name at
        // all — not even an implicit one — so no locator can address it and it is not reported. The
        // function inside it is a different question, and answering it with silence would be the
        // same defect the companion case above describes.
        assertEquals(listOf("Service", "task", "run"), names)
    }
}
