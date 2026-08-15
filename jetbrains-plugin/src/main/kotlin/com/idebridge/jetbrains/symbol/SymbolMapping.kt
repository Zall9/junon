package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.Position
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Range
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.protocol.SymbolLocator
import java.security.MessageDigest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * Turns a language's declaration tree into IDEBP symbols.
 *
 * The platform reports declarations as PSI elements carrying **text offsets**; IDEBP speaks
 * line/character positions in UTF-16 code units. That conversion, the structural bounds, and the
 * locator identity are all here — deliberately free of platform types, so they are exercised
 * without an IDE. The platform-facing binding only has to describe each declaration as a [Node].
 *
 * Bounds match the VS Code adapter's, because they protect the same thing: a consumer that asked
 * for one document's symbols must not receive an unbounded tree, and a provider that returns one
 * must fail rather than be truncated silently.
 */
public object SymbolMapping {
    public const val MAX_DOCUMENT_SYMBOLS: Int = 5_000
    public const val MAX_SYMBOL_DEPTH: Int = 64
    public const val MAX_SYMBOL_TEXT_LENGTH: Int = 1_024

    /**
     * One declaration, as the platform sees it.
     *
     * Offsets are into the document text. [selectionStart]/[selectionEnd] delimit the identifier —
     * what a rename would replace — and must lie inside the declaration.
     */
    public interface Node<A> {
        public val name: String
        public val kind: SymbolKind

        /** The IDE's own name for this declaration's form; see `SymbolLocator.declarationType`. */
        public val declarationType: String?
        public val declarationStart: Int
        public val declarationEnd: Int
        public val selectionStart: Int
        public val selectionEnd: Int

        /** Whatever the platform can later resolve back to the element, in O(1). */
        public val anchor: A
        public val children: List<Node<A>>
    }

    /**
     * Maps a document's declaration tree.
     *
     * Refuses rather than truncates: a result that exceeded the bounds would otherwise be
     * indistinguishable from a document that genuinely has that few symbols.
     */
    public fun <A> mapDocument(
        nodes: List<Node<A>>,
        documentUri: String,
        index: LineIndex,
    ): List<SymbolHandleRegistry.Draft<A>> {
        val state = State()
        return nodes.map { map(it, documentUri, index, containerName = null, depth = 0, state) }
    }

    private class State {
        var count: Int = 0
        val seen: MutableSet<Any> = java.util.Collections.newSetFromMap(java.util.IdentityHashMap())
    }

    private fun <A> map(
        node: Node<A>,
        documentUri: String,
        index: LineIndex,
        containerName: String?,
        depth: Int,
        state: State,
    ): SymbolHandleRegistry.Draft<A> {
        // A cycle would otherwise recurse until the stack gives out; the identity check is what
        // makes a malformed provider a refusal rather than a crash.
        require(depth <= MAX_SYMBOL_DEPTH) { "Symbol tree exceeds structural bounds" }
        require(state.count < MAX_DOCUMENT_SYMBOLS) { "Symbol tree exceeds structural bounds" }
        require(state.seen.add(node)) { "Symbol tree exceeds structural bounds" }
        state.count += 1

        val name = symbolText(node.name)
        val declaration = index.range(node.declarationStart, node.declarationEnd)
        val selection = index.range(node.selectionStart, node.selectionEnd)
        require(contains(declaration, selection)) {
            "A symbol's identifier must lie inside its declaration"
        }

        return SymbolHandleRegistry.Draft(
            locator = createLocator(
                documentUri,
                name,
                node.kind,
                selection,
                containerName,
                node.declarationType,
            ),
            range = declaration,
            anchor = node.anchor,
            children = node.children.map {
                map(it, documentUri, index, containerName = name, depth = depth + 1, state)
            },
        )
    }

    /**
     * Builds a locator, whose fingerprint is a digest of the fields that identify the symbol.
     *
     * The fingerprint is **not** comparable with the VS Code adapter's and is not meant to be: a
     * locator is relocated only by the adapter that minted it, within its own workspace, so a
     * shared canonical form would buy nothing and would force both languages to agree on JSON
     * escaping edge cases. What must agree across adapters is the relocation *rule*, and that is
     * pinned by shared vectors (ADR-0025).
     */
    public fun createLocator(
        documentUri: String,
        name: String,
        kind: SymbolKind,
        selectionRange: Range,
        containerName: String?,
        declarationType: String? = null,
    ): SymbolLocator = SymbolLocator(
        documentUri = documentUri,
        name = name,
        kind = kind,
        declarationType = declarationType,
        containerName = containerName,
        selectionRange = selectionRange,
        positionEncoding = PositionEncoding.UTF16,
        fingerprint = fingerprint(documentUri, name, kind, selectionRange, containerName),
    )

    private fun fingerprint(
        documentUri: String,
        name: String,
        kind: SymbolKind,
        selectionRange: Range,
        containerName: String?,
    ): String {
        val identity = Json.encodeToString(
            ListSerializer(String.serializer()),
            listOf(
                documentUri,
                name,
                kind.name,
                containerName.orEmpty(),
                selectionRange.start.line.toString(),
                selectionRange.start.character.toString(),
                selectionRange.end.line.toString(),
                selectionRange.end.character.toString(),
            ),
        )
        val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
        return "sha256:" + digest.joinToString("") { "%02x".format(it) }
    }

    private fun symbolText(value: String): String {
        require(value.isNotBlank()) { "A symbol name cannot be blank" }
        require(value.length <= MAX_SYMBOL_TEXT_LENGTH) { "A symbol name exceeds structural bounds" }
        return value
    }

    private fun contains(outer: Range, inner: Range): Boolean =
        compare(outer.start, inner.start) <= 0 && compare(inner.end, outer.end) <= 0

    private fun compare(left: Position, right: Position): Int =
        if (left.line == right.line) left.character - right.character else left.line - right.line
}
