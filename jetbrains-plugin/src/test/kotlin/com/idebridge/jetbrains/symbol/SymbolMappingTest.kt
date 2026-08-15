package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.SymbolKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SymbolMappingTest {
    private val documentUri = "file:///projects/demo/src/Service.java"

    private class TestNode(
        override val name: String,
        override val kind: SymbolKind,
        override val declarationStart: Int,
        override val declarationEnd: Int,
        override val selectionStart: Int,
        override val selectionEnd: Int,
        override val declarationType: String? = null,
        override val anchor: String = "anchor:$name",
        override var children: List<SymbolMapping.Node<String>> = emptyList(),
    ) : SymbolMapping.Node<String>

    // Offsets below refer to this text; line 0 is the package statement.
    private val text = """
        package demo;

        class Service {
            void run() {}
        }
    """.trimIndent()

    private val index = LineIndex(text)

    private fun offsetOf(needle: String): Int = text.indexOf(needle).also {
        require(it >= 0) { "fixture text does not contain '$needle'" }
    }

    @Test
    fun `converts offsets to line and character positions`() {
        val classOffset = offsetOf("Service")

        val position = index.position(classOffset)

        assertEquals(2, position.line, "the class declaration is on the third line")
        assertEquals("class ".length, position.character)
    }

    @Test
    fun `counts characters in UTF-16 code units, as the protocol declares`() {
        // An astral character occupies two UTF-16 code units. Expectations here are written as
        // literals rather than derived from the same indices under test, which would compare the
        // implementation with itself and hold no matter what it did.
        //
        //          0123   4,5   6
        val text = "val 🚀 x"
        val emojiIndex = LineIndex(text)

        assertEquals(4, emojiIndex.position(4).character, "the emoji starts at column 4")
        assertEquals(6, emojiIndex.position(6).character, "it occupies two code units, not one")
        // A position counted in code points would report 5 here and every range after an astral
        // character would be applied one column too far left.
        assertEquals(7, emojiIndex.position(7).character, "the identifier follows at column 7")
    }

    @Test
    fun `treats only a newline as a line break`() {
        // An IntelliJ Document normalises separators to '\n'. Splitting on a lone '\r' as well
        // would report positions the platform's own offsets disagree with.
        val carriageReturn = LineIndex("a\rb\nc")

        assertEquals(0, carriageReturn.position(2).line)
        assertEquals(1, carriageReturn.position(4).line)
    }

    @Test
    fun `maps a declaration tree, nesting container names`() {
        val method = TestNode(
            name = "run",
            kind = SymbolKind.METHOD,
            declarationStart = offsetOf("void run() {}"),
            declarationEnd = offsetOf("void run() {}") + "void run() {}".length,
            selectionStart = offsetOf("run"),
            selectionEnd = offsetOf("run") + "run".length,
        )
        val klass = TestNode(
            name = "Service",
            kind = SymbolKind.CLASS,
            declarationStart = offsetOf("class Service"),
            declarationEnd = text.length,
            selectionStart = offsetOf("Service"),
            selectionEnd = offsetOf("Service") + "Service".length,
        ).apply { children = listOf(method) }

        val drafts = SymbolMapping.mapDocument(listOf(klass), documentUri, index)

        val mappedClass = drafts.single()
        assertEquals("Service", mappedClass.locator.name)
        assertEquals(SymbolKind.CLASS, mappedClass.locator.kind)
        assertNull(mappedClass.locator.containerName, "a top-level symbol has no container")
        assertEquals("anchor:Service", mappedClass.anchor)

        val mappedMethod = mappedClass.children.single()
        assertEquals("run", mappedMethod.locator.name)
        assertEquals("Service", mappedMethod.locator.containerName)
        assertEquals("anchor:run", mappedMethod.anchor)
        assertEquals(3, mappedMethod.locator.selectionRange.start.line)
    }

    @Test
    fun `distinguishes the declaration range from the identifier range`() {
        val klass = TestNode(
            name = "Service",
            kind = SymbolKind.CLASS,
            declarationStart = offsetOf("class Service"),
            declarationEnd = text.length,
            selectionStart = offsetOf("Service"),
            selectionEnd = offsetOf("Service") + "Service".length,
        )

        val draft = SymbolMapping.mapDocument(listOf(klass), documentUri, index).single()

        // The declaration spans the body; the identifier is the name alone. A rename replaces the
        // second, so collapsing them would rewrite the whole class.
        assertEquals(SymbolKind.CLASS, draft.locator.kind)
        assertNotEquals(draft.range, draft.locator.selectionRange)
        assertEquals("Service".length, draft.locator.selectionRange.let {
            it.end.character - it.start.character
        })
    }

    @Test
    fun `refuses an identifier that falls outside its declaration`() {
        val broken = TestNode(
            name = "Service",
            kind = SymbolKind.CLASS,
            declarationStart = offsetOf("class Service"),
            declarationEnd = offsetOf("class Service") + 5,
            selectionStart = offsetOf("void run"),
            selectionEnd = offsetOf("void run") + 4,
        )

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(broken), documentUri, index)
        }
    }

    @Test
    fun `refuses an offset beyond the document`() {
        val beyond = TestNode(
            name = "Service",
            kind = SymbolKind.CLASS,
            declarationStart = 0,
            declarationEnd = text.length + 1,
            selectionStart = 0,
            selectionEnd = 1,
        )

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(beyond), documentUri, index)
        }
    }

    @Test
    fun `refuses a blank name rather than emitting an unusable locator`() {
        val blank = TestNode(
            name = "   ",
            kind = SymbolKind.CLASS,
            declarationStart = 0,
            declarationEnd = 5,
            selectionStart = 0,
            selectionEnd = 5,
        )

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(blank), documentUri, index)
        }
    }

    @Test
    fun `refuses a tree deeper than the bound`() {
        var node = TestNode("leaf", SymbolKind.CLASS, 0, 5, 0, 5)
        repeat(SymbolMapping.MAX_SYMBOL_DEPTH + 1) {
            node = TestNode("n$it", SymbolKind.CLASS, 0, 5, 0, 5).apply { children = listOf(node) }
        }

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(node), documentUri, index)
        }
    }

    @Test
    fun `refuses more symbols than the bound rather than truncating`() {
        val many = (0..SymbolMapping.MAX_DOCUMENT_SYMBOLS)
            .map { TestNode("s$it", SymbolKind.FIELD, 0, 5, 0, 5) }

        // Truncating would be indistinguishable from a document that genuinely has that few.
        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(many, documentUri, index)
        }
    }

    @Test
    fun `refuses a cyclic tree instead of recursing until the stack fails`() {
        val node = TestNode("Service", SymbolKind.CLASS, 0, 5, 0, 5)
        node.children = listOf(node)

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(node), documentUri, index)
        }
    }

    @Test
    fun `refuses the same declaration reused in two places`() {
        // A cycle is already stopped by the depth bound, so it does not exercise the identity
        // check. A shared subtree is shallow: only identity catches it, and without that the same
        // element would be minted twice and count once.
        val shared = TestNode("run", SymbolKind.METHOD, 0, 5, 0, 5)
        val parent = TestNode("Service", SymbolKind.CLASS, 0, 5, 0, 5)
            .apply { children = listOf(shared, shared) }

        assertFailsWith<IllegalArgumentException> {
            SymbolMapping.mapDocument(listOf(parent), documentUri, index)
        }
    }

    @Test
    fun `fingerprints distinguish symbols that differ in any identifying field`() {
        val range = index.range(0, 5)
        val base = SymbolMapping.createLocator(documentUri, "Service", SymbolKind.CLASS, range, null)

        val byName = SymbolMapping.createLocator(documentUri, "Other", SymbolKind.CLASS, range, null)
        val byKind =
            SymbolMapping.createLocator(documentUri, "Service", SymbolKind.INTERFACE, range, null)
        val byContainer =
            SymbolMapping.createLocator(documentUri, "Service", SymbolKind.CLASS, range, "Outer")
        val byRange = SymbolMapping.createLocator(
            documentUri,
            "Service",
            SymbolKind.CLASS,
            index.range(1, 5),
            null,
        )
        val byUri = SymbolMapping.createLocator(
            "file:///projects/demo/src/Other.java",
            "Service",
            SymbolKind.CLASS,
            range,
            null,
        )

        val all = listOf(base, byName, byKind, byContainer, byRange, byUri).map { it.fingerprint }
        assertEquals(all.size, all.toSet().size, "each identifying field must change the digest")
        assertTrue(all.all { it.startsWith("sha256:") && it.length == "sha256:".length + 64 })
    }

    @Test
    fun `the same symbol fingerprints identically across calls`() {
        val range = index.range(0, 5)

        assertEquals(
            SymbolMapping.createLocator(documentUri, "Service", SymbolKind.CLASS, range, "Outer")
                .fingerprint,
            SymbolMapping.createLocator(documentUri, "Service", SymbolKind.CLASS, range, "Outer")
                .fingerprint,
        )
    }
}
