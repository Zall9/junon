package com.idebridge.jetbrains.platform

import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * A file this IDE cannot parse is said so, rather than reported as declaring nothing.
 *
 * Found by using the product: `ide_symbols_overview` on a TypeScript file under IntelliJ IDEA
 * Community returned an empty list. Community ships no JavaScript support, so that answer was
 * correct and useless — indistinguishable from a file with nothing in it. PhpStorm, which does ship
 * it, answered thirteen symbols for the same file, which is what turns "empty" into a statement
 * about the IDE rather than about the code.
 *
 * The distinction existed inside the adapter and was thrown away by one operator:
 * `StructureViewSymbols.declarations(file) ?: childDeclarations(file)` replaced "this IDE cannot
 * describe this file" with a generic walk that finds nothing in a file it cannot parse.
 */
class LanguageUnsupportedTest : BasePlatformTestCase() {

    fun `test a language this IDE parses is describable`() {
        val file = myFixture.configureByText("Service.java", "class Service { void run() {} }")

        assertTrue(StructureViewSymbols.describes(file))
    }

    fun `test an empty file of a known language is still describable`() {
        // The case the refusal must not swallow: nothing to report is a fact about the file, and
        // the caller is entitled to an empty list rather than a refusal.
        val file = myFixture.configureByText("Empty.java", "")

        assertTrue(StructureViewSymbols.describes(file))
    }

    fun `test a file no language plugin claims is not describable`() {
        val file = myFixture.configureByText("notes.unknownext", "some text that is not a language")

        assertFalse(
            "no structure view means no plugin understands this file, whatever it contains",
            StructureViewSymbols.describes(file),
        )
    }

    fun `test a TypeScript file is not describable by a build without JavaScript support`() {
        // The case this exists for. Measured: such a file is opened by the TextMate fallback, whose
        // language is neither Java nor plain text — which is why testing the language name was the
        // wrong signal and the structure view is the right one.
        val file = myFixture.configureByText("module.ts", "export class Thing { run(): void {} }")

        assertFalse(StructureViewSymbols.describes(file))
    }
}
