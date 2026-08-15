package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.Location
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.DefinitionsScopedSearch
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiTreeUtil

/**
 * One step of a call or type hierarchy, answered by the IDE's own resolution.
 *
 * A hierarchy is walked one level at a time rather than returned as a tree. That is how the IDE
 * computes it, it bounds a response without a depth parameter to get wrong, and it lets the result
 * reuse the same location shape the daemon already checks for containment and handle authority.
 *
 * No language is named here. Callers come from `ReferencesSearch` and the enclosing declaration of
 * each hit; callees from resolving the references inside a declaration; subtypes from
 * `DefinitionsScopedSearch`. Each is a platform service every language plugin contributes to, which
 * is why a PHP method's callers come from PhpStorm's index and a Go interface's implementors from
 * GoLand's.
 *
 * Callers must already hold a read action.
 */
public object IntelliJHierarchy {

    public sealed interface Outcome {
        public data class Found(val locations: List<Location>, val truncated: Boolean) : Outcome

        /**
         * The relation has no language-neutral engine behind it.
         *
         * Stated rather than approximated: walking a declaration's header looking for type
         * references would produce something that resembles supertypes in some languages and
         * misleads in others, and a wrong hierarchy is worse than an absent one.
         */
        public data object UnsupportedRelation : Outcome
    }

    public enum class Relation { CALLERS, CALLEES, SUBTYPES, SUPERTYPES }

    public fun of(project: Project, element: PsiElement, relation: Relation): Outcome =
        when (relation) {
            Relation.CALLERS -> bounded(callers(project, element))
            Relation.CALLEES -> bounded(callees(element))
            Relation.SUBTYPES -> bounded(subtypes(element))
            Relation.SUPERTYPES -> Outcome.UnsupportedRelation
        }

    /**
     * The declarations that reference [element].
     *
     * A reference's own location is the call site; the caller is the declaration containing it,
     * which is what a hierarchy means. Hits with no enclosing named declaration — a reference from
     * a file's top level, say — are dropped rather than reported as a caller with no identity.
     */
    private fun callers(project: Project, element: PsiElement): List<Location> {
        val found = mutableListOf<Location>()
        val seen = mutableSetOf<PsiElement>()
        ReferencesSearch.search(element, GlobalSearchScope.projectScope(project)).forEach { ref ->
            if (found.size >= IntelliJNavigation.MAX_RESULTS) return@forEach
            val owner = enclosingDeclaration(ref.element) ?: return@forEach
            if (!seen.add(owner)) return@forEach
            locationOf(owner)?.let { found.add(it) }
        }
        return found
    }

    /**
     * The declarations referenced from inside [element].
     *
     * Resolution is the language's own: each reference in the subtree is asked what it points at,
     * and only named declarations elsewhere are kept. References that resolve back inside [element]
     * are dropped — a declaration is not its own callee, and recursion would otherwise report it as
     * one.
     */
    private fun callees(element: PsiElement): List<Location> {
        val found = mutableListOf<Location>()
        val seen = mutableSetOf<PsiElement>()
        for (reference in PsiTreeUtil.collectElements(element) { true }) {
            if (found.size >= IntelliJNavigation.MAX_RESULTS) break
            for (ref in reference.references) {
                val target = ref.resolve() ?: continue
                if (target !is PsiNameIdentifierOwner) continue
                if (PsiTreeUtil.isAncestor(element, target, false)) continue
                if (!seen.add(target)) continue
                locationOf(target)?.let { found.add(it) }
            }
        }
        return found
    }

    /** Implementors and overrides, as the language defines them. */
    private fun subtypes(element: PsiElement): List<Location> {
        val found = mutableListOf<Location>()
        DefinitionsScopedSearch.search(element).forEach { definition ->
            if (found.size >= IntelliJNavigation.MAX_RESULTS) return@forEach
            locationOf(definition)?.let { found.add(it) }
        }
        return found
    }

    /**
     * The nearest named declaration containing [element], or `null`.
     *
     * `strict = false` would return the element itself when it is already a declaration; a
     * reference never is, so the distinction does not arise, but the search starts at the parent to
     * make that explicit rather than incidental.
     */
    private fun enclosingDeclaration(element: PsiElement): PsiNameIdentifierOwner? =
        PsiTreeUtil.getParentOfType(element, PsiNameIdentifierOwner::class.java, true)

    private fun bounded(found: List<Location>): Outcome.Found =
        Outcome.Found(
            found.take(IntelliJNavigation.MAX_RESULTS),
            truncated = found.size >= IntelliJNavigation.MAX_RESULTS,
        )

    private fun locationOf(element: PsiElement): Location? =
        IntelliJNavigation.locationOfDeclaration(element)
}
