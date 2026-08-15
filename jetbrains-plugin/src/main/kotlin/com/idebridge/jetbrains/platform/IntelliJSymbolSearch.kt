package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolKindMapper
import com.intellij.navigation.ChooseByNameContributor
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner

/**
 * Workspace-wide symbol search, backed by the IDE's own "Go to Symbol" index.
 *
 * `ChooseByNameContributor` is what populates that dialog, and every language plugin registers one,
 * so searching a PHP project in PhpStorm queries PhpStorm's index and a Go project GoLand's. No
 * language is named here.
 *
 * Callers must already hold a read action.
 */
public object IntelliJSymbolSearch {

    /**
     * How many matching names are resolved to declarations before giving up.
     *
     * The bound is on the **expensive** half of a search. Reading a name and testing it against the
     * query touches strings the platform already holds; `getItemsByName` reads the index and builds
     * PSI, which is what an unbounded broad query would spend a consumer's patience on. Stopping
     * early and saying so still beats an answer that arrives too late — the guarantee ADR-0017 states
     * — but it is now the resolving that stops, not the reading.
     *
     * This was measured, in a real IDE, on 2026-08-10 (ADR-0032). The previous bound counted names
     * *seen*, and the contributors return the JDK's and Kotlin's own names even when asked for project
     * items only: in a running IntelliJ the budget was exhausted by library names before the scan
     * reached the project's, so a search for a declaration plainly present in the open project
     * answered with nothing at all — truthfully flagged `truncated`, and useless. A fixture project is
     * too small to ever reach the bound, which is why only a real IDE could show it.
     */
    public const val MAX_RESOLVED_NAMES: Int = 20_000

    public data class Found(val elements: List<PsiNameIdentifierOwner>, val truncated: Boolean)

    /**
     * Declarations whose name contains [query], case-insensitively.
     *
     * Substring rather than the IDE's fuzzy matching: fuzzy ranking is a presentation decision for a
     * human picking from a list, and a consumer asking for a name means the name. Non-project items
     * are excluded — a match in a library is not editable and would fail the daemon's containment
     * check anyway.
     */
    /**
     * @param kinds when given, only declarations the IDE classifies as one of these are returned.
     *   `null` means every kind, which is not the same as an empty set — an empty set asks for
     *   nothing and gets nothing.
     *
     * The filter was measured to be missing on 2026-08-11, by asking a real PhpStorm for `class` and
     * receiving methods. The protocol has always declared the parameter and the VS Code adapter has
     * always honoured it, so the two adapters answered the same request differently: one filtered,
     * one silently did not, and a filter that is ignored returns a wrong answer wearing the shape of
     * a right one.
     */
    public fun search(
        project: Project,
        query: String,
        limit: Int,
        kinds: Set<SymbolKind>? = null,
    ): Found {
        if (query.isBlank() || limit < 1) return Found(emptyList(), false)
        val found = linkedSetOf<PsiNameIdentifierOwner>()
        var resolved = 0
        var exhausted = true

        for (contributor in ChooseByNameContributor.SYMBOL_EP_NAME.extensionList) {
            val names = runCatching { contributor.getNames(project, false) }.getOrNull() ?: continue
            for (name in names) {
                if (found.size >= limit) return Found(found.toList(), true)
                // Case-insensitive in place: lowercasing every name allocated a string per name in
                // the index, and none of them survived the comparison.
                if (!name.contains(query, ignoreCase = true)) continue
                if (++resolved > MAX_RESOLVED_NAMES) {
                    exhausted = false
                    break
                }
                val items: Array<NavigationItem> =
                    runCatching { contributor.getItemsByName(name, query, project, false) }
                        .getOrNull() ?: continue
                for (item in items) {
                    if (found.size >= limit) return Found(found.toList(), true)
                    val declaration = named(item) ?: continue
                    // Filtered here rather than after the search, so a rejected kind does not spend
                    // the caller's limit: filtering a completed page of results would answer "three
                    // classes" for a project holding twenty, and would mark the answer complete.
                    if (kinds != null && SymbolKindMapper.classify(declaration) !in kinds) continue
                    found.add(declaration)
                }
            }
            // Only a spent resolve budget stops the remaining contributors, and then because nothing
            // more can be resolved anyway. Breaking because one contributor's *names* ran long — as
            // this did — let a single large contributor starve every other language in the IDE.
            if (!exhausted) break
        }
        return Found(found.toList(), truncated = !exhausted)
    }

    /**
     * The declaration behind a navigation item, when there is one.
     *
     * What makes an item addressable by a locator is the language naming it; whether the text also
     * spells that name out is a separate question, answered by `PsiSymbols.identifierRange`
     * (ADR-0030). Requiring an identifier here was measured on 2026-08-09 to drop a Kotlin companion
     * object from every search result: the IDE's own index offers the name `Companion`, and the
     * response carried neither the hit nor any sign that one had been removed.
     *
     * An item the language does not name, or that belongs to no file, is still dropped — no locator
     * could address it.
     */
    private fun named(item: NavigationItem): PsiNameIdentifierOwner? {
        val element = item as? PsiElement ?: return null
        val named = element as? PsiNameIdentifierOwner ?: return null
        return if (named.name != null && named.containingFile != null) named else null
    }
}
