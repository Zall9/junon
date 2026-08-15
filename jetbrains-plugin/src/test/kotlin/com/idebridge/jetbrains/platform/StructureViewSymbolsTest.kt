package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolHandleRegistry
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Exercises the structure-view mapping against a real IDE, with Java as the sample language.
 *
 * Nothing here is Java-specific by design: `StructureViewSymbols` names no language, and the tree,
 * the names and the offsets all come from whichever language plugin owns the file. Java is simply
 * what this test IDE parses.
 *
 * The kinds asserted below are still not Java knowledge held by this plugin. They are what Java's
 * own provider answers when the platform asks it to describe a declaration, which
 * `PlatformSymbolKindMapper` matches against the protocol's vocabulary and otherwise leaves alone.
 * `NAME` staying unknown in a file where everything else classifies is the load-bearing case: the
 * IDE calls it a "constant field", naming two kinds at once, and nothing here picks between them.
 */
class StructureViewSymbolsTest : BasePlatformTestCase() {

    private val source = """
        package demo;

        public class Service<T> {
            private int count;
            static final String NAME = "n";

            Service() {}

            public void run(int times) {}

            interface Callback {
                void onDone();
            }

            enum Mode { FAST, SLOW }
        }
    """.trimIndent()

    private fun drafts(): List<SymbolHandleRegistry.Draft<PsiAnchor>> {
        val file = myFixture.configureByText("Service.java", source) as PsiJavaFile
        val nodes = PsiSymbols.declarations(file)
        val index = LineIndex(file.text)
        return SymbolMapping.mapDocument(nodes, "file:///demo/Service.java", index)
    }

    private fun SymbolHandleRegistry.Draft<PsiAnchor>.child(name: String) =
        children.single { it.locator.name == name }

    fun `test maps a Java file to one top-level class with its members nested`() {
        val service = drafts().single()

        assertEquals("Service", service.locator.name)
        assertEquals(SymbolKind.CLASS, service.locator.kind)
        assertNull("a top-level class has no container", service.locator.containerName)

        val names = service.children.map { it.locator.name }.toSet()
        // No "T": the IDE's structure model lists a class's members, not its type parameters. This
        // expectation follows what the IDE actually reports rather than what a raw PSI walk finds —
        // taking the IDE's engine as the source means taking its answer about what a file contains.
        assertEquals(setOf("count", "NAME", "Service", "run", "Callback", "Mode"), names)
        for (child in service.children) {
            assertEquals("Service", child.locator.containerName)
        }
    }

    // Type parameters are absent throughout: see the note above on the structure model.
    fun `test reports the kind the language itself supplies`() {
        val service = drafts().single()

        // This test used to assert `unknown` for all six, and it was right to: no mapper had ever
        // been contributed, so the adapter genuinely could not categorise anything. It can now, and
        // still without a line of Java knowledge — each of these is Java's own word for the
        // declaration, matched against the protocol's vocabulary and used only on an exact hit.
        assertEquals(SymbolKind.FIELD, service.child("count").locator.kind)
        assertEquals(SymbolKind.CONSTRUCTOR, service.child("Service").locator.kind)
        assertEquals(SymbolKind.METHOD, service.child("run").locator.kind)
        assertEquals(SymbolKind.INTERFACE, service.child("Callback").locator.kind)
        assertEquals(SymbolKind.ENUM, service.child("Mode").locator.kind)
    }

    fun `test a static final field is not inferred to be anything`() {
        // Java has no constant declaration, and this adapter has no Java knowledge to apply even if
        // it did. Both reasons point the same way: nothing is inferred.
        assertEquals(SymbolKind.UNKNOWN, drafts().single().child("NAME").locator.kind)
    }

    fun `test the identifier range covers the name alone, not the declaration`() {
        val run = drafts().single().child("run")

        val selection = run.locator.selectionRange
        assertEquals("the identifier is on one line", selection.start.line, selection.end.line)
        assertEquals("run".length, selection.end.character - selection.start.character)

        // The declaration spans further than its identifier — a rename must replace only the latter.
        assertTrue(
            "the declaration must extend past the identifier",
            run.range.end.character > selection.end.character ||
                run.range.end.line > selection.end.line,
        )
    }

    fun `test offsets land on the text they claim, line and column`() {
        val file = myFixture.configureByText("Service.java", source) as PsiJavaFile
        val lines = file.text.split("\n")
        val nodes = PsiSymbols.declarations(file)
        val mapped = SymbolMapping.mapDocument(
            nodes,
            "file:///demo/Service.java",
            LineIndex(file.text),
        )

        // Reading the name back out of the raw text at the reported position is what proves the
        // offset conversion against the platform, rather than against itself.
        fun assertReadsBack(draft: SymbolHandleRegistry.Draft<PsiAnchor>) {
            val selection = draft.locator.selectionRange
            val line = lines[selection.start.line]
            assertEquals(
                "the reported position must contain the reported name",
                draft.locator.name,
                line.substring(selection.start.character, selection.end.character),
            )
            draft.children.forEach(::assertReadsBack)
        }
        mapped.forEach(::assertReadsBack)
    }

    fun `test anchors resolve back to the element that produced them`() {
        val service = drafts().single()

        val anchor = service.child("run").anchor.element
        assertNotNull("a smart pointer must still resolve in the same session", anchor)
        assertEquals("run", (anchor as com.intellij.psi.PsiMethod).name)
    }

    fun `test skips a declaration the platform reports without a name`() {
        val file = myFixture.configureByText(
            "Anon.java",
            """
            package demo;

            class Holder {
                static { }
                Runnable r = new Runnable() { public void run() {} };
            }
            """.trimIndent(),
        ) as PsiJavaFile

        val mapped = SymbolMapping.mapDocument(
            PsiSymbols.declarations(file),
            "file:///demo/Anon.java",
            LineIndex(file.text),
        )

        // The initializer has no name, so no locator can address it: absent rather than present
        // under an invented name — and its presentation text, "static class initializer", is a
        // rendering for a human and never becomes one.
        //
        // `run` is absent for a different reason, which is the IDE's and not this adapter's. Java's
        // structure model does not descend into an anonymous class at all, so the method inside it is
        // never offered here; measured 2026-08-09. Kotlin's model does list its anonymous objects,
        // and there the member inside one *is* reported — see OtherLanguageSymbolsTest. The adapter
        // reports what each language's model gives it, which is the point of reading that model.
        val holder = mapped.single()
        assertEquals(listOf("r"), holder.children.map { it.locator.name })
    }
}
