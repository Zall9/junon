package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.SymbolKind
import com.intellij.psi.ElementDescriptionUtil
import com.intellij.psi.PsiElement
import com.intellij.usageView.UsageViewTypeLocation
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.serializer

/**
 * The kind each language tells the IDE, carried rather than inferred.
 *
 * [SymbolKindMapper] was written expecting host IDEs to contribute classifiers, but nothing outside
 * this repository knows the extension point exists, so nothing ever did: `classify` fell through to
 * [SymbolKind.UNKNOWN] for every symbol of every language. The kind field was structurally dead.
 *
 * It need not be. When the platform renders Find Usages it asks each language's own
 * `FindUsagesProvider` what a declaration is, and that answer is measurably in the same vocabulary
 * the protocol uses: Java says `class`, `interface`, `enum`, `constructor`, `method`, `field`;
 * Kotlin says `class`, `interface`, `object`, `property`, `function`. Those are the protocol's own
 * words, produced by the language, not by us.
 *
 * So this mapper authors no correspondence table. It reads the vocabulary out of the wire contract
 * itself and asks whether the IDE used one of those words. A word we do not recognise stays
 * [SymbolKind.UNKNOWN] — which is exactly today's behaviour, so nothing can regress.
 *
 * Two measured limits, kept visible rather than papered over:
 *
 * - **The platform normalises only as far as each language bothers to.** Kotlin's provider answers
 *   `class` for an `enum class` *and* for its entries, where Java distinguishes `enum` from
 *   `enum constant`. That coarseness is the IDE's own, and it is reported as the IDE gave it; the
 *   alternative is this plugin second-guessing a language it deliberately knows nothing about.
 * - **Compound phrases are refused, not resolved.** Java calls `static final int` a `constant field`
 *   and Kotlin calls a companion a `companion object`. Each names two vocabulary words at once, and
 *   picking one would be our judgement rather than the IDE's, so both stay unknown.
 *
 * The phrases in [EQUIVALENT_PHRASES] are the opposite case: each is a multi-word spelling of
 * exactly one vocabulary word, with no second candidate to choose between. They are listed
 * individually so each can be checked, and they name no language.
 */
public class PlatformSymbolKindMapper : SymbolKindMapper {

    override fun kindOf(element: PsiElement): SymbolKind? {
        val described = runCatching {
            ElementDescriptionUtil.getElementDescription(element, UsageViewTypeLocation.INSTANCE)
        }.getOrNull() ?: return null

        return BY_PLATFORM_WORD[described.trim().lowercase()]
    }

    private companion object {

        /**
         * Platform spellings of a single vocabulary word.
         *
         * `enum constant` is LSP's `enumMember` and nothing else; `type parameter` is
         * `typeParameter`; a `local variable` is a `variable`. Contrast `constant field`, which
         * names both `constant` and `field` and is therefore absent.
         */
        val EQUIVALENT_PHRASES: Map<String, SymbolKind> = mapOf(
            "enum constant" to SymbolKind.ENUM_MEMBER,
            "type parameter" to SymbolKind.TYPE_PARAMETER,
            "local variable" to SymbolKind.VARIABLE,
        )

        /**
         * The protocol's vocabulary, read from the wire contract rather than copied.
         *
         * Copying the list would let it drift from the schema silently; taking it from the
         * serializer means a kind added to the protocol is understood here the moment it exists.
         */
        @OptIn(ExperimentalSerializationApi::class)
        val BY_PLATFORM_WORD: Map<String, SymbolKind> = buildMap {
            val descriptor = serializer<SymbolKind>().descriptor
            for (kind in SymbolKind.entries) {
                put(descriptor.getElementName(kind.ordinal).lowercase(), kind)
            }
            putAll(EQUIVALENT_PHRASES)
        }
    }
}
