package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.ChangeSummary
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.refactoring.RefactoringFactory
import com.intellij.refactoring.RenameRefactoring
import com.intellij.usageView.UsageInfo

/**
 * Renames through the IDE's own refactoring engine.
 *
 * Phase one asks the engine which usages it would change and reports them as a summary; phase two
 * runs the engine. The plan is a summary — `{uri, editCount}` per document — not a diff, so
 * applying the real refactoring rather than replaying computed text edits is what the contract
 * describes, and it keeps the guarantee genuinely `semantic`: the engine updates imports, overriding
 * methods and qualified references, none of which a textual replay would do.
 *
 * Describing this as a semantic rename is therefore accurate, which AGENTS.md §4 requires it to be
 * before the word is used.
 *
 * Callers must be on the EDT for [apply], which mutates PSI; [prepare] only reads.
 */
public object IntelliJRename {

    /**
     * Upper bound on usages carried in one plan. A rename touching more than this is refused
     * rather than summarised, because the consumer could neither review nor undo it meaningfully.
     */
    public const val MAX_USAGES: Int = 5_000

    public class Prepared internal constructor(
        internal val refactoring: RenameRefactoring,
        internal val usages: Array<UsageInfo>,
        public val changes: List<ChangeSummary>,
        public val warnings: List<String>,
    )

    public sealed interface Outcome {
        public data class Ready(val prepared: Prepared) : Outcome

        public enum class Refusal { NOT_RENAMABLE, TOO_MANY_USAGES, NO_USAGES }

        public data class Refused(val reason: Refusal) : Outcome
    }

    public fun prepare(project: Project, element: PsiElement, newName: String): Outcome {
        // Renamability is checked here rather than inferred from the result. The engine accepts an
        // element it cannot rename — an expression, for instance — and simply finds no usages, so
        // once the declaration's own file is counted below, an empty result no longer distinguishes
        // "nothing to rename" from "a declaration with no references". Requiring a name identifier
        // is the same rule the symbol mapper reads: it reports a declaration the language names
        // without spelling — a Kotlin companion — because a consumer needs the members inside it,
        // and gives it an empty selection range precisely because there is no text to replace. This
        // refusal is where that becomes a stated answer rather than an implication.
        if (element !is PsiNameIdentifierOwner || element.nameIdentifier == null) {
            return Outcome.Refused(Outcome.Refusal.NOT_RENAMABLE)
        }

        val refactoring = runCatching {
            RefactoringFactory.getInstance(project).createRename(element, newName)
        }.getOrNull() ?: return Outcome.Refused(Outcome.Refusal.NOT_RENAMABLE)

        // Comment and string occurrences are textual matches, not references. Including them would
        // make a `semantic` guarantee untrue for part of the change.
        refactoring.isSearchInComments = false
        refactoring.isSearchInNonJavaFiles = false

        val usages = runCatching { refactoring.findUsages() }.getOrNull()
            ?: return Outcome.Refused(Outcome.Refusal.NOT_RENAMABLE)
        if (usages.size > MAX_USAGES) return Outcome.Refused(Outcome.Refusal.TOO_MANY_USAGES)

        val byFile = linkedMapOf<String, Int>()
        // `findUsages` returns references only — the declaration is rewritten by the engine but is
        // not among them. Counting it here is what stops the plan understating which documents
        // change; a consumer reading the summary would otherwise never learn that this file moves.
        element.containingFile?.virtualFile?.url?.let { byFile[it] = 1 }
        var unattributable = 0
        for (usage in usages) {
            val uri = usage.virtualFile?.url
            if (uri == null) {
                unattributable += 1
                continue
            }
            byFile[uri] = (byFile[uri] ?: 0) + 1
        }
        // With the declaration counted above this is empty only when even it has no file, which
        // means the engine found nothing this adapter can describe.
        if (byFile.isEmpty()) return Outcome.Refused(Outcome.Refusal.NO_USAGES)

        val warnings = buildList {
            if (unattributable > 0) {
                // Named rather than hidden: the plan's counts would otherwise silently understate
                // what applying it changes.
                add("$unattributable usage(s) could not be attributed to a file and are not counted")
            }
            if (usages.any { it.isNonCodeUsage }) {
                add("Some usages are outside code and will not be renamed")
            }
        }

        return Outcome.Ready(
            Prepared(
                refactoring = refactoring,
                usages = usages,
                changes = byFile.map { (uri, count) -> ChangeSummary(uri = uri, editCount = count) },
                warnings = warnings,
            ),
        )
    }

    /**
     * Runs the refactoring the engine prepared.
     *
     * The usages found during [prepare] are passed back rather than recomputed, so what is applied
     * is what was summarised. Whether the document still matches is decided before this by the
     * plan's revision preconditions, not here.
     */
    public fun apply(prepared: Prepared) {
        prepared.refactoring.doRefactoring(prepared.usages)
    }
}
