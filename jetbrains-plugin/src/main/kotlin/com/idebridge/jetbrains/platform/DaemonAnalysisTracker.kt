package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import java.util.Collections

/**
 * Records which documents the IDE has actually finished analysing.
 *
 * Needed because `getHighlights` answers with what the daemon has **already** computed: a document
 * it has never looked at comes back empty, and empty is indistinguishable from clean. Without this,
 * `diagnostics/getSnapshot` would quietly report a file with errors as problem-free.
 *
 * Uses only public API — `DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC` and `isHighlightingAvailable` —
 * unlike the highlight read itself (ADR-0027), so it adds nothing to the internal-API baseline.
 */
public class DaemonAnalysisTracker(private val project: Project) : Disposable {

    private val analysed: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    /** Subscribes to the daemon. Call once per project; dispose with the project's lifetime. */
    public fun start() {
        project.messageBus.connect(this).subscribe(
            DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC,
            object : DaemonCodeAnalyzer.DaemonListener {
                override fun daemonFinished(fileEditors: Collection<com.intellij.openapi.fileEditor.FileEditor>) {
                    for (editor in fileEditors) {
                        editor.file?.url?.let { analysed.add(it) }
                    }
                }

                // A cancelled run leaves the document in whatever state it reached, which is not a
                // finished analysis; forgetting it keeps the answer honest rather than optimistic.
                override fun daemonCancelEventOccurred(reason: String) {
                    analysed.clear()
                }
            },
        )
    }

    /** Forgets a document, so an edit makes the next answer incomplete until the daemon catches up. */
    public fun invalidate(uri: String) {
        analysed.remove(uri)
    }

    public fun state(file: PsiFile, document: Document): DiagnosticMapping.Analysis {
        val analyzer = DaemonCodeAnalyzer.getInstance(project)
        // Nothing will ever be produced for this file, so an empty answer is the complete truth
        // rather than something to keep waiting for.
        if (!analyzer.isHighlightingAvailable(file)) return DiagnosticMapping.Analysis.UNAVAILABLE

        val uri = FileDocumentManager.getInstance().getFile(document)?.url
        // Deliberately not consulted: `DaemonCodeAnalyzer.isRunning()` would say whether a pass is
        // in flight, but the Plugin Verifier reports it as internal API. It is not needed — a
        // document is complete only after a finish event, and [invalidate] takes it back to pending
        // on every change — so the second internal dependency is avoided rather than baselined.
        return if (uri != null && uri in analysed) {
            DiagnosticMapping.Analysis.COMPLETED
        } else {
            DiagnosticMapping.Analysis.PENDING
        }
    }

    /** Marks a document analysed. For callers that observed completion by other means. */
    public fun markAnalysed(uri: String) {
        analysed.add(uri)
    }

    override fun dispose() {
        analysed.clear()
    }
}
