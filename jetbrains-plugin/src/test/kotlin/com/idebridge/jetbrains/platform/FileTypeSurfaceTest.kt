package com.idebridge.jetbrains.platform

import com.intellij.lang.LanguageParserDefinitions
import com.intellij.lang.LanguageStructureViewBuilder
import com.intellij.psi.PsiFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * What the platform actually says about a file it has no plugin for.
 *
 * The first predicate for "this IDE cannot describe this file" guessed at the answer — plain-text
 * language, or a missing structure view — and was wrong in a way that only showed up against a real
 * IDE: a TypeScript file under a build with no JavaScript support still answered an empty symbol
 * list rather than a refusal.
 *
 * So the inputs are printed and pinned here before anything is built on them.
 */
class FileTypeSurfaceTest : BasePlatformTestCase() {

    private fun describe(name: String, content: String): String {
        val file: PsiFile = myFixture.configureByText(name, content)
        val builder = LanguageStructureViewBuilder.getInstance().getStructureViewBuilder(file)
        val parser = LanguageParserDefinitions.INSTANCE.forLanguage(file.language)
        return "language=${file.language.id} fileType=${file.fileType.name} " +
            "structureView=${builder != null} parser=${parser != null} " +
            "children=${file.children.size}"
    }

    fun `test what the platform reports for parsed and unparsed files`() {
        val cases = listOf(
            "Service.java" to "class Service { void run() {} }",
            "Empty.java" to "",
            "module.ts" to "export class Thing { run(): void {} }",
            "script.js" to "export function run() {}",
            "data.json" to """{"a": 1}""",
            "notes.md" to "# Title",
            "notes.unknownext" to "plain words",
            "plain.txt" to "plain words",
        )
        for ((name, content) in cases) {
            println("  ${name.padEnd(22)} ${describe(name, content)}")
        }

        // The one thing this must keep true whatever the platform does: a language the IDE parses
        // is describable even when the file is empty.
        val empty = myFixture.configureByText("Empty2.java", "")
        assertTrue(StructureViewSymbols.describes(empty))
    }
}
