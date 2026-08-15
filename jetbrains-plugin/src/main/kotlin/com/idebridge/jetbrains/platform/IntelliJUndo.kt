package com.idebridge.jetbrains.platform

import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager

/**
 * Undo, driven through the IDE's own stack.
 *
 * Every edit this adapter applies runs inside a `WriteCommandAction`, so it is already an entry in
 * the IDE's undo history — the same entry a user's Ctrl+Z would reach. Reverting through that stack
 * keeps one history rather than a second, parallel one that could disagree with what the user sees.
 *
 * **The editor is passed explicitly, never inferred from focus.** IntelliJ's undo is scoped to a
 * file editor, and relying on whichever one happens to be focused would let an agent's undo revert a
 * document its plan never named — with the user watching a different file entirely.
 */
public object IntelliJUndo {

    public sealed interface Outcome {
        public data object Reverted : Outcome

        /** Nothing to undo for this document, which is a fact rather than a failure. */
        public data object NothingToUndo : Outcome

        /** The IDE will not undo here — the document is closed, or the entry has been superseded. */
        public data object Refused : Outcome
    }

    /**
     * Reverts the last change to [file]. Must run on the dispatch thread.
     *
     * Opening the editor is deliberate: the undo entry belongs to a file editor, so there has to be
     * one to undo in. It is the same editor the user would see, not a hidden context.
     */
    public fun undo(project: Project, file: VirtualFile): Outcome {
        // Opening an editor is what this needs and what a headless harness cannot give: the undo
        // entry belongs to a file editor. A failure here is reported as a refusal rather than
        // thrown, so a caller learns the IDE would not undo instead of that the adapter broke.
        val editor = runCatching {
            val manager = FileEditorManager.getInstance(project)
            manager.getSelectedEditor(file) ?: manager.openFile(file, false).firstOrNull()
        }.getOrNull() ?: return Outcome.Refused

        val undoManager = UndoManager.getInstance(project)
        if (!undoManager.isUndoAvailable(editor)) return Outcome.NothingToUndo
        undoManager.undo(editor)
        // Undo reverts the *document*; PSI catches up only when committed. A caller that reads
        // `PsiFile.text` before this gets the pre-undo text and concludes nothing changed — which
        // is how a working revert was reported to the daemon as an unmodified document, and
        // refused, for a whole day of wrong explanations.
        PsiDocumentManager.getInstance(project).commitAllDocuments()
        // Persist, as applying does. Leaving the revert in an unsaved buffer would put the
        // editor and the disk in disagreement — and an agent that undid a change would find it
        // still on disk, which is worse than not undoing at all.
        FileDocumentManager.getInstance().saveAllDocuments()
        return Outcome.Reverted
    }
}
