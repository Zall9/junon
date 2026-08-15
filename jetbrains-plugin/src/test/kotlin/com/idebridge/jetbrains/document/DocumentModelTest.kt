package com.idebridge.jetbrains.document

import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Workspace
import com.idebridge.jetbrains.protocol.WorkspaceRoot
import com.idebridge.jetbrains.protocol.WorkspaceTrust
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DocumentModelTest {
    private val workspace = Workspace(
        workspaceId = "ws_1",
        adapterId = "adapter_1",
        name = "demo",
        roots = listOf(
            WorkspaceRoot("root_1", "demo", "file:///projects/demo"),
            WorkspaceRoot("root_2", "shared", "file:///projects/shared"),
        ),
        workspaceEpoch = 7,
        trust = WorkspaceTrust.TRUSTED,
    )

    @Test
    fun `a buffer carries an editor version and the epoch`() {
        val versions = EditorVersionRegistry()
        versions.recordChange("file:///projects/demo/src/a.kt")
        versions.recordChange("file:///projects/demo/src/a.kt")
        val model = DocumentModel(versions)

        val outcome = model.read(
            workspace,
            "file:///projects/demo/src/a.kt",
            DocumentModel.Source.Buffer("fun main() {}\n", isDirty = true),
            languageId = "kotlin",
        )

        assertTrue(outcome is DocumentModel.Outcome.Ready)
        val document = outcome.content.document
        assertEquals("root_1", document.rootId)
        assertEquals("src/a.kt", document.logicalPath)
        assertEquals(2, document.revision.editorVersion)
        assertEquals(7, document.revision.workspaceEpoch)
        assertEquals(PositionEncoding.UTF16, document.positionEncoding)
        assertEquals("kotlin", document.languageId)
        assertTrue(document.isDirty)
        assertTrue(document.revision.contentHash.startsWith("sha256:"))
    }

    @Test
    fun `disk content claims no editor version and is never dirty`() {
        val outcome = DocumentModel().read(
            workspace,
            "file:///projects/demo/src/a.kt",
            DocumentModel.Source.Disk("fun main() {}\n"),
        )

        assertTrue(outcome is DocumentModel.Outcome.Ready)
        // Absent, not zero: a file on disk exists in no editor and must not claim otherwise.
        assertNull(outcome.content.document.revision.editorVersion)
        assertTrue(!outcome.content.document.isDirty)
    }

    @Test
    fun `identical content hashes identically regardless of its source`() {
        val model = DocumentModel()
        val text = "package demo\n"
        val buffered = model.read(
            workspace,
            "file:///projects/demo/a.kt",
            DocumentModel.Source.Buffer(text, isDirty = false),
        )
        val onDisk =
            model.read(workspace, "file:///projects/demo/a.kt", DocumentModel.Source.Disk(text))

        assertTrue(buffered is DocumentModel.Outcome.Ready && onDisk is DocumentModel.Outcome.Ready)
        // contentHash is what a precondition rests on, so it must not depend on where the bytes
        // came from.
        assertEquals(
            buffered.content.document.revision.contentHash,
            onDisk.content.document.revision.contentHash,
        )
    }

    @Test
    fun `selects the root that actually contains the document`() {
        val outcome = DocumentModel().read(
            workspace,
            "file:///projects/shared/lib/b.kt",
            DocumentModel.Source.Disk(""),
        )
        assertTrue(outcome is DocumentModel.Outcome.Ready)
        assertEquals("root_2", outcome.content.document.rootId)
        assertEquals("lib/b.kt", outcome.content.document.logicalPath)
    }

    @Test
    fun `refuses a document outside every root`() {
        assertEquals(
            DocumentModel.Outcome.Refused(DocumentModel.Outcome.Refusal.OUTSIDE_WORKSPACE),
            DocumentModel().read(
                workspace,
                "file:///elsewhere/secret.kt",
                DocumentModel.Source.Disk(""),
            ),
        )
        // A sibling sharing a name prefix is outside too.
        assertEquals(
            DocumentModel.Outcome.Refused(DocumentModel.Outcome.Refusal.OUTSIDE_WORKSPACE),
            DocumentModel().read(
                workspace,
                "file:///projects/demo-two/a.kt",
                DocumentModel.Source.Disk(""),
            ),
        )
    }

    @Test
    fun `refuses a traversal that would escape the root`() {
        assertEquals(
            DocumentModel.Outcome.Refused(DocumentModel.Outcome.Refusal.OUTSIDE_WORKSPACE),
            DocumentModel().read(
                workspace,
                "file:///projects/demo/../secret.kt",
                DocumentModel.Source.Disk(""),
            ),
        )
    }

    @Test
    fun `hashes differ as soon as content differs`() {
        assertNotEquals(DocumentModel.hash("a"), DocumentModel.hash("b"))
        assertEquals(DocumentModel.hash("same"), DocumentModel.hash("same"))
        // UTF-8 is the hashing encoding, so non-ASCII content hashes stably.
        assertEquals(DocumentModel.hash("π = 3"), DocumentModel.hash("π = 3"))
    }

    @Test
    fun `editor versions are per document and monotonic`() {
        val versions = EditorVersionRegistry()
        assertEquals(0, versions.current("file:///a"))
        assertEquals(1, versions.recordChange("file:///a"))
        assertEquals(2, versions.recordChange("file:///a"))
        assertEquals(0, versions.current("file:///b"))

        versions.forget("file:///a")
        assertEquals(0, versions.current("file:///a"))
    }
}
