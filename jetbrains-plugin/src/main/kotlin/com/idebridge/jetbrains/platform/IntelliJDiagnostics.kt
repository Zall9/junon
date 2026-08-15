package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.Project

/**
 * Reads the IDE's current highlights for a document.
 *
 * **This file uses internal platform API and is the only one that does.** IntelliJ exposes no
 * public way to read what the daemon has highlighted: `HighlightInfo` is annotated
 * `@ApiStatus.Internal` at class level, and every route to a diagnostic's severity and message goes
 * through it. The alternatives were weighed and rejected — running inspections through the public
 * `InspectionManager` yields a *different, partial* set that omits annotator and compiler errors,
 * and presenting that as "the IDE's diagnostics" would misrepresent it (AGENTS.md §4).
 *
 * The exposure is contained to the two symbols below, converted immediately into
 * [DiagnosticMapping.Highlight], so a platform change touches this file and nothing above it. See
 * ADR-0027.
 *
 * Callers must hold a read action.
 */
public object IntelliJDiagnostics {

    /**
     * Below this, highlights are syntax colouring rather than problems — the daemon reports every
     * token at `INFORMATION` and below. Asking for weak warnings and above is what makes the
     * result a diagnostic set instead of a rendering of the file.
     */
    private val MINIMUM_SEVERITY: HighlightSeverity = HighlightSeverity.WEAK_WARNING

    private class PlatformHighlight(
        override val severityLevel: Int,
        override val startOffset: Int,
        override val endOffset: Int,
        override val message: String?,
        override val source: String?,
        override val fixes: List<DiagnosticMapping.Fix>,
    ) : DiagnosticMapping.Highlight

    /**
     * The fixes the IDE offers for one highlight.
     *
     * `findRegisteredQuickFix` is the public way in, and it stops at the first non-null the
     * processor returns — so the processor records and returns null, visiting every offer. The
     * alternative was `quickFixActionRanges`, which is internal: this keeps the baselined surface
     * at the two symbols diagnostics already require rather than growing it for a convenience.
     *
     * The title is the IDE's own wording, never interpreted here. The id is derived from the
     * action's family and text rather than an object identity, because a consumer receives it in
     * one snapshot and passes it back in a later request.
     */
    private fun fixesOf(info: HighlightInfo): List<DiagnosticMapping.Fix> {
        val collected = mutableListOf<DiagnosticMapping.Fix>()
        val seen = mutableSetOf<String>()
        info.findRegisteredQuickFix<Unit> { descriptor, _ ->
            // `action.text` is a placeholder until the platform initialises the action, so the
            // descriptor's own display name is preferred. Whichever answers, the result is checked
            // below rather than trusted: publishing an internal class name would be worse than
            // publishing nothing.
            val action = descriptor.action
            val title = fixTitle(descriptor, action)
            if (isUsable(title) && collected.size < MAX_FIXES) {
                // Digested rather than concatenated: an IDE's family name and title together run
                // past the protocol's 128-character ceiling for verbose fixes, which is exactly how
                // this field first closed the adapter's session. A digest is bounded, stable across
                // the snapshot, and derived from the same two strings so it stays distinguishing.
                val id = digest("${action.familyName}\u0000${title}")
                // A repeated identifier would make two offers indistinguishable, and the daemon's
                // conformance rules refuse that — so a duplicate is dropped rather than renumbered
                // into something a later request could not resolve back.
                if (seen.add(id)) collected.add(DiagnosticMapping.Fix(id, title))
            }
            null
        }
        return collected
    }

    /**
     * The action behind a published `fixId`, or `null`.
     *
     * Deliberately stateless: the id is **re-derived** from the document's current highlights
     * rather than looked up in a registry the adapter kept. That makes the resolution fail closed
     * for free — if the document changed, the analysis moved on, or the offer is simply gone, the
     * digest no longer matches and the request is refused instead of applying whatever fix now
     * occupies that position. A stored handle would have to detect the same staleness explicitly,
     * and getting that wrong means silently applying a fix nobody chose.
     *
     * Callers must already hold a read action.
     */
    public fun resolveFix(project: Project, document: Document, fixId: String): IntentionAction? {
        val highlights = DaemonCodeAnalyzerImpl.getHighlights(document, MINIMUM_SEVERITY, project)
        for (info in highlights) {
            val match = info.findRegisteredQuickFix { descriptor, _ ->
                val action = descriptor.action
                val title = fixTitle(descriptor, action)
                if (isUsable(title) && digest("${action.familyName}\u0000${title}") == fixId) {
                    action
                } else {
                    null
                }
            }
            if (match != null) return match
        }
        return null
    }

    /**
     * What the IDE calls this fix, in the wording a user would see in the editor.
     *
     * `action.text` is the fix's own sentence — "Remove unused import", "Delete variable" — and is
     * what a consumer needs to choose between offers. It is tried first. It is only a placeholder
     * (`(not initialized) class …`) before the platform initialises the action, and the descriptor's
     * display name covers that case.
     *
     * The order matters and was wrong once: preferring `displayName` published `"Annotator"` for a
     * Go fix, because that field can carry the *inspection's* label rather than the fix's. A
     * consumer choosing between two offers called "Annotator" learns nothing, which is the same
     * failure as publishing a class name — legible, and useless.
     */
    private fun fixTitle(
        descriptor: HighlightInfo.IntentionActionDescriptor,
        action: IntentionAction,
    ): String {
        val own = plainText(action.text)
        if (isUsable(own)) return own
        return plainText(descriptor.displayName.orEmpty())
    }

    /** Matches the protocol ceiling; a longer list would be refused on the wire. */
    private const val MAX_FIXES = 32

    /**
     * Strips the markup the platform sometimes wraps a fix title in.
     *
     * Titles arrive both bare and as `<html>…</html>`. This adapter already refuses to read
     * `getToolTip()` because platform HTML routinely embeds the offending source text; the same
     * caution applies to anything else carrying tags. A consumer gets wording it can display,
     * never markup it would have to render or strip itself.
     */
    internal fun plainText(value: String): String =
        value.replace(Regex("<[^>]*>"), "").trim()

    /**
     * Whether a title is the IDE's wording rather than a placeholder.
     *
     * An uninitialised `IntentionAction` reports `"(not initialized) class …QuickFix"`. Publishing
     * that would put an internal class name where a consumer expects a fix it can choose, so an
     * offer that cannot name itself is dropped instead. Checked by shape rather than by exact
     * string: the wording is the platform's, and it is not a contract.
     */
    internal fun isUsable(title: String): Boolean =
        title.isNotBlank() &&
            !title.startsWith("(not initialized)") &&
            !title.startsWith("class com.intellij")

    /** Short, stable, and comfortably inside the protocol's 128-character ceiling. */
    private fun digest(value: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .take(16)
            .joinToString("") { "%02x".format(it) }

    public fun highlights(
        project: Project,
        document: Document,
    ): List<DiagnosticMapping.Highlight> =
        DaemonCodeAnalyzerImpl.getHighlights(document, MINIMUM_SEVERITY, project).map {
            PlatformHighlight(
                severityLevel = it.severity.myVal,
                startOffset = it.startOffset,
                endOffset = it.endOffset,
                // `description` is the short message. `getToolTip()` is deliberately not read: it
                // is HTML that routinely embeds the offending source text, which must never leave
                // the IDE in a diagnostic.
                message = it.description,
                source = it.inspectionToolId,
                fixes = fixesOf(it),
            )
        }
}
