package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.SymbolKind
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.psi.PsiElement

/**
 * Classifies a declaration for one language.
 *
 * IDEBP's symbol kinds are a fixed vocabulary, and only a language's own PSI knows which one a
 * declaration belongs to — a PHP trait, a Go interface and a Kotlin object are not derivable from
 * anything generic. So classification is an extension point rather than a table in this plugin:
 * **what the adapter can classify is decided by the IDE it was installed into**, which is the whole
 * point. CLion contributes its C++ knowledge, PhpStorm its PHP knowledge, and neither has to be
 * anticipated here.
 *
 * Returning `null` means "not mine" — the next mapper is tried, and a declaration no mapper claims
 * is reported as [SymbolKind.UNKNOWN] rather than guessed at.
 */
public interface SymbolKindMapper {

    /** The kind of [element], or `null` when this mapper does not handle its language. */
    public fun kindOf(element: PsiElement): SymbolKind?

    public companion object {
        public val EP_NAME: ExtensionPointName<SymbolKindMapper> =
            ExtensionPointName.create("com.idebridge.jetbrains.symbolKindMapper")

        /**
         * Asks every mapper the host IDE contributed, in registration order.
         *
         * Falls back to [SymbolKind.UNKNOWN], which is the truthful answer for a named declaration
         * whose category this IDE does not expose. Reporting it as `class` or `function` would be a
         * guess, and a consumer acting on a guessed kind is worse off than one told nothing — the
         * name, the range and navigation all remain usable without it.
         */
        public fun classify(element: PsiElement): SymbolKind {
            for (mapper in EP_NAME.extensionList) {
                mapper.kindOf(element)?.let { return it }
            }
            return SymbolKind.UNKNOWN
        }
    }
}
