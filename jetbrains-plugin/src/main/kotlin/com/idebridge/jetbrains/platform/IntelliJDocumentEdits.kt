package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.EditOperation
import com.intellij.codeInsight.actions.OptimizeImportsProcessor
import com.intellij.psi.PsiFile
import com.intellij.psi.codeStyle.CodeStyleManager

/**
 * Document-scoped edits performed by the IDE's own engines.
 *
 * `CodeStyleManager` and `OptimizeImportsProcessor` are platform services: each language plugin
 * registers its own implementation, so reformatting a PHP file in PhpStorm runs PhpStorm's
 * formatter and a Go file in GoLand runs GoLand's. Nothing about any language appears here, and the
 * result is the IDE's own, not an approximation of it.
 *
 * Neither operation takes a target beyond the document, which is why they are the two that prove
 * the generalised plan model without needing operation-specific arguments.
 */
public object IntelliJDocumentEdits {

    /** The operations this file can perform. Anything else is not this object's to claim. */
    public val SUPPORTED: Set<EditOperation> =
        setOf(EditOperation.REFORMAT, EditOperation.OPTIMIZE_IMPORTS)

    /**
     * Runs [operation] on [file]. Must be called inside a write action on the dispatch thread.
     *
     * Both engines rewrite the document in place, so what a caller reports as modified is the file
     * itself, and the content hash before and after is what says whether anything changed. An
     * already-formatted file legitimately changes nothing.
     */
    public fun apply(operation: EditOperation, file: PsiFile) {
        when (operation) {
            EditOperation.REFORMAT -> CodeStyleManager.getInstance(file.project).reformat(file)
            EditOperation.OPTIMIZE_IMPORTS ->
                OptimizeImportsProcessor(file.project, file).run()

            else -> error("IntelliJDocumentEdits cannot perform $operation")
        }
    }

    /**
     * What [operation] would change, as a guarantee.
     *
     * Reformatting rewrites layout, never meaning, so claiming `semantic` would overstate it.
     * Optimising imports does change what the file references, which is why it is the stronger of
     * the two.
     */
    public fun guarantee(operation: EditOperation): com.idebridge.jetbrains.protocol.Guarantee =
        when (operation) {
            EditOperation.REFORMAT -> com.idebridge.jetbrains.protocol.Guarantee.SYNTACTIC
            else -> com.idebridge.jetbrains.protocol.Guarantee.SEMANTIC
        }
}
