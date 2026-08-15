package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.Location
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.DefinitionsScopedSearch
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.openapi.project.Project

/**
 * Navigation, answered by the IDE's own search engines.
 *
 * `ReferencesSearch` and `DefinitionsScopedSearch` are platform services: each language plugin
 * contributes its own resolution, so finding references to a PHP method in PhpStorm uses PhpStorm's
 * index and a Go interface's implementations in GoLand uses GoLand's. No language is named here,
 * and none had to be anticipated.
 *
 * This is what the adapter could not do before: without it an agent can read a file's symbols but
 * cannot follow a call to where it is defined.
 *
 * Callers must already hold a read action.
 */
public object IntelliJNavigation {

    /**
     * Upper bound on results. A search that would exceed it is reported as truncated rather than
     * cut silently, because a capped list presented as complete is the failure mode that matters.
     */
    public const val MAX_RESULTS: Int = 1_000

    public data class Found(val locations: List<Location>, val truncated: Boolean)

    /** Where [element] is declared. A declaration is its own definition. */
    public fun definition(element: PsiElement): Found =
        bounded(listOfNotNull(locationOf(element)))

    /**
     * Everywhere [element] is referenced, project-wide.
     *
     * The scope is the project rather than the whole IDE: results outside it would point at
     * libraries the consumer cannot edit, and would fail the daemon's containment check anyway.
     */
    public fun references(project: Project, element: PsiElement): Found {
        val found = mutableListOf<Location>()
        ReferencesSearch.search(element, GlobalSearchScope.projectScope(project)).forEach { ref ->
            if (found.size >= MAX_RESULTS) return@forEach
            locationOf(ref.element, ref.rangeInElement?.shiftRight(ref.element.textRange.startOffset))
                ?.let { found.add(it) }
        }
        return bounded(found)
    }

    /** Implementations or overrides of [element], as the language defines them. */
    public fun implementations(element: PsiElement): Found {
        val found = mutableListOf<Location>()
        DefinitionsScopedSearch.search(element).forEach { definition ->
            if (found.size >= MAX_RESULTS) return@forEach
            locationOf(definition)?.let { found.add(it) }
        }
        return bounded(found)
    }

    /**
     * The declaration at [offset], if any.
     *
     * Returns the named declaration containing the offset rather than the token under it: a
     * consumer asking "what symbol is here" means the declaration, and a bare identifier token is
     * not addressable by a locator.
     */
    public fun declarationAt(file: com.intellij.psi.PsiFile, offset: Int): PsiNameIdentifierOwner? =
        com.intellij.psi.util.PsiTreeUtil.findElementOfClassAtOffset(
            file,
            offset,
            PsiNameIdentifierOwner::class.java,
            false,
        )

    private fun bounded(found: List<Location>): Found =
        Found(found.take(MAX_RESULTS), truncated = found.size >= MAX_RESULTS)

    /**
     * The wire location of a declaration, shared with [IntelliJHierarchy].
     *
     * Exposed rather than duplicated: the rules about what cannot be located — no file, no range, a
     * range the index does not cover — must hold identically for a hierarchy step and a lookup, or
     * the daemon would accept one and refuse the other for the same element.
     */
    public fun locationOfDeclaration(element: PsiElement): Location? = locationOf(element)

    /**
     * Converts an element to a wire location.
     *
     * Returns `null` for anything without a file or a text range — an element from a library stub,
     * or a synthetic one the language invented. Reporting a location it cannot substantiate would
     * send the consumer somewhere that does not exist.
     */
    private fun locationOf(
        element: PsiElement,
        range: com.intellij.openapi.util.TextRange? = null,
    ): Location? {
        val file = element.containingFile ?: return null
        val uri = file.virtualFile?.url ?: return null
        val extent = range ?: (element as? PsiNameIdentifierOwner)?.nameIdentifier?.textRange
            ?: element.textRange
            ?: return null
        val index = LineIndex(file.text)
        if (!index.covers(extent.startOffset, extent.endOffset)) return null
        return Location(
            uri = uri,
            range = index.range(extent.startOffset, extent.endOffset),
            positionEncoding = PositionEncoding.UTF16,
        )
    }
}
