package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.Position
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Range
import com.idebridge.jetbrains.protocol.SymbolHandle
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.protocol.SymbolLocator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SymbolHandleRegistryTest {
    private val documentUri = "file:///projects/demo/src/a.kt"
    private val otherUri = "file:///projects/demo/src/b.kt"

    private val context = SymbolHandleRegistry.Context(
        adapterId = "adapter_1",
        sessionId = "session_1",
        workspaceId = "ws_1",
        workspaceEpoch = 3,
        editorVersion = 7,
    )

    private fun locator(name: String, uri: String = documentUri) = SymbolLocator(
        documentUri = uri,
        name = name,
        kind = SymbolKind.CLASS,
        selectionRange = Range(Position(1, 0), Position(1, name.length)),
        positionEncoding = PositionEncoding.UTF16,
        fingerprint = "sha256:" + "a".repeat(64),
    )

    private fun draft(
        name: String,
        uri: String = documentUri,
        children: List<String> = emptyList(),
    ): SymbolHandleRegistry.Draft<String> =
        SymbolHandleRegistry.Draft(
            locator = locator(name, uri),
            range = Range(Position(1, 0), Position(3, 1)),
            anchor = "anchor:$name",
            children = children.map { draft(it, uri) },
        )

    @Test
    fun `binds handles to the adapter, session, and epoch, and resolves to the anchor`() {
        val registry = SymbolHandleRegistry<String>()
        val symbols = registry.materializeDocument(listOf(draft("Service")), documentUri, context)

        val handle = symbols.single().handle
        assertEquals("adapter_1", handle.adapterId)
        assertEquals("session_1", handle.sessionId)
        assertEquals(3, handle.validUntilEpoch)

        val resolved = registry.resolve(handle, context)
        assertTrue(resolved != null)
        assertEquals("anchor:Service", resolved.anchor)
        assertEquals(documentUri, resolved.documentUri)
        assertEquals(7, resolved.editorVersion)
    }

    @Test
    fun `refuses a handle from another adapter, session, or epoch`() {
        val registry = SymbolHandleRegistry<String>()
        val handle = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle

        assertNull(registry.resolve(handle.copy(adapterId = "adapter_other"), context))
        assertNull(registry.resolve(handle, context.copy(sessionId = "session_other")))
        assertNull(registry.resolve(handle, context.copy(workspaceEpoch = 4)))
        assertNull(registry.resolve(handle, context.copy(workspaceId = "ws_other")))
        assertNull(
            registry.resolve(
                SymbolHandle("adapter_1", "session_1", "sym_unknown", 3),
                context,
            ),
        )
    }

    @Test
    fun `mints a handle for every symbol in a tree`() {
        val registry = SymbolHandleRegistry<String>()
        val symbols = registry.materializeDocument(
            listOf(draft("Service", children = listOf("run", "stop"))),
            documentUri,
            context,
        )

        assertEquals(2, symbols.single().children.size)
        assertEquals(3, registry.size)
        for (child in symbols.single().children) {
            assertTrue(registry.resolve(child.handle, context) != null)
        }
    }

    @Test
    fun `recomputing a document replaces exactly its own handles`() {
        val registry = SymbolHandleRegistry<String>()
        val first = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle
        registry.materializeDocument(listOf(draft("Other", otherUri)), otherUri, context)

        val second = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle

        assertNotEquals(first.id, second.id)
        assertNull(registry.resolve(first, context), "the replaced handle must be revoked")
        assertEquals(2, registry.size, "the other document's handle must survive")
    }

    @Test
    fun `a transient result never revokes handles a document handed out`() {
        val registry = SymbolHandleRegistry<String>()
        val documentHandle = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle
        assertEquals(1, registry.size)

        registry.materializeTransient(listOf(draft("Service")), context)

        assertEquals(2, registry.size, "the transient handle is added, not substituted")
        assertTrue(
            registry.resolve(documentHandle, context) != null,
            "the document handle must still resolve",
        )
    }

    @Test
    fun `changing a document revokes both namespaces for it`() {
        val registry = SymbolHandleRegistry<String>()
        val documentHandle = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle
        val transientHandle = registry.materializeTransient(listOf(draft("Service")), context)
            .single()
            .handle
        registry.materializeDocument(listOf(draft("Other", otherUri)), otherUri, context)

        registry.invalidateDocument("ws_1", documentUri)

        assertNull(registry.resolve(documentHandle, context))
        assertNull(registry.resolve(transientHandle, context))
        assertEquals(1, registry.size, "an unrelated document keeps its handles")
    }

    @Test
    fun `transient generations are evicted oldest first rather than failing`() {
        val registry = SymbolHandleRegistry<String>(maxHandles = 1)
        val first = registry.materializeTransient(listOf(draft("Service")), context).single().handle
        val second = registry.materializeTransient(listOf(draft("Service")), context).single().handle

        assertNotEquals(first.id, second.id)
        assertNull(registry.resolve(first, context), "the oldest generation is evicted")
        assertEquals(1, registry.size)

        // A document result still takes priority over accumulated transient history.
        registry.materializeDocument(listOf(draft("Service")), documentUri, context)
        assertEquals(1, registry.size)
    }

    @Test
    fun `capacity is refused only once no transient history remains`() {
        val registry = SymbolHandleRegistry<String>(maxHandles = 1)
        registry.materializeDocument(listOf(draft("Service")), documentUri, context)

        assertFailsWith<IllegalArgumentException> {
            registry.materializeDocument(listOf(draft("Other", otherUri)), otherUri, context)
        }
    }

    @Test
    fun `invalidating everything leaves no resolvable handle`() {
        val registry = SymbolHandleRegistry<String>()
        val handle = registry
            .materializeDocument(listOf(draft("Service")), documentUri, context)
            .single()
            .handle

        registry.invalidateAll()

        assertEquals(0, registry.size)
        assertNull(registry.resolve(handle, context))
    }
}
