package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolKindMapper
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.structureView.TreeBasedStructureViewBuilder
import com.intellij.ide.util.treeView.smartTree.TreeElement
import com.intellij.lang.LanguageStructureViewBuilder
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.SmartPointerManager

/**
 * Reads a file's declarations from the IDE's own structure model.
 *
 * This is the tree the "Structure" tool window shows, built by whichever language plugin owns the
 * file: CLion's for C++, PhpStorm's for PHP, GoLand's for Go. Nothing about any language is written
 * here, and none had to be anticipated — the adapter's reach is whatever the IDE it was installed
 * into can already parse.
 *
 * It also replaces a judgement this plugin had no business making. The previous walker inferred
 * nesting by finding the nearest named ancestor; the structure model *is* the language's own answer
 * to what contains what, including cases a generic walk gets wrong — extension blocks, PHP traits,
 * C++ namespaces split across files.
 *
 * **Kind is the part the platform does not publish.** `TreeElement` offers a presentation — text and
 * an icon — not a typed classification, so there is no engine to ask. Kinds therefore come from
 * [SymbolKindMapper] where an IDE contributes one, and are [SymbolKind.UNKNOWN] otherwise. That is
 * a limit of the platform, not a shortcut taken here.
 *
 * **A row this adapter cannot describe is transparent, not opaque.** Structure views legitimately
 * contain rows that are not declarations — a grouping node, a file header — and rows for
 * declarations no locator can address, because the language gives them no name. Reporting such a
 * row is impossible, but discarding what it *contains* would be a different answer entirely: on
 * 2026-08-09 that was measured to lose every declaration inside a Kotlin `companion object`, whose
 * name the language supplies (`Companion`) while spelling no identifier for it, so a factory
 * function or constant declared there came back as nothing at all. The row is therefore skipped and
 * its own rows are read in its place, which is the same rule [PsiSymbols] states for the walk it
 * falls back to.
 *
 * Callers must already hold a read action.
 */
public object StructureViewSymbols {

    /**
     * Declarations of [file], or `null` when the IDE has no structure model for its language.
     *
     * `null` is distinct from an empty list: one means "this IDE cannot describe this file", the
     * other "it can, and there is nothing in it". A caller that conflated them would report an
     * unparseable file as empty.
     */
    public fun declarations(file: PsiFile): List<SymbolMapping.Node<PsiAnchor>>? {
        val builder = LanguageStructureViewBuilder.getInstance().getStructureViewBuilder(file)
        if (builder !is TreeBasedStructureViewBuilder) return null

        // A null editor is the documented way to build the model headlessly; the structure of a file
        // does not depend on which editor happens to show it.
        val model = builder.createStructureViewModel(null)
        return try {
            model.root.children.flatMap { declarations(it, file) }
        } finally {
            model.dispose()
        }
    }

    /**
     * What one structure-view row contributes: itself when it is a declaration this adapter can
     * address, and otherwise whatever the rows inside it contribute.
     */
    /**
     * Internal rather than private so a test can hand it a tree shape directly.
     *
     * The shape is the variable: which rows a language nests under which is exactly what differs
     * between languages, and the bundled languages available to the test fixture do not produce the
     * shape this guards against — measured, with a Java fixture passing identically whether the
     * containment rule was present or removed.
     */
    /**
     * Whether a language plugin here claims [file] well enough to describe its structure.
     *
     * This is the discriminating signal, measured rather than guessed. Under a build with no
     * JavaScript support, a `.ts` file is opened by the **TextMate** fallback — not as plain text —
     * so testing the language against `PlainTextLanguage` said "supported" and the first version of
     * this predicate let the empty answer through. A parser definition is no better: every
     * language has one, plain text included.
     *
     *     Service.java  structureView=true   language=JAVA
     *     Empty.java    structureView=true   language=JAVA
     *     module.ts     structureView=false  language=textmate
     *     data.json     structureView=true   language=JSON
     *
     * The empty Java file is why this must not be combined with "found no declarations": a
     * supported language with nothing in it owes the caller an empty list, not a refusal.
     */
    public fun describes(file: PsiFile): Boolean =
        LanguageStructureViewBuilder.getInstance().getStructureViewBuilder(file) != null

    internal fun declarations(
        element: TreeElement,
        file: PsiFile,
        within: TextRange? = null,
    ): List<SymbolMapping.Node<PsiAnchor>> {
        val value = (element as? StructureViewTreeElement)?.value as? PsiElement
        // An element from another file (an inherited member shown for context) is not this
        // document's to report, and neither is anything under it; its offsets would not even
        // address this text. This is the one case where a row is opaque rather than transparent,
        // because the statement is about the whole subtree and not about this row's name.
        if (value != null && value.containingFile != file) return emptyList()

        // The same statement, for an inherited member whose base class happens to live in this file.
        // Measured against a real PyCharm: `IdeStatusTool` declares only `apply`, yet the model
        // offered `_client`, `_workspace_id` and `_explain` beneath it, carrying the ranges of
        // `IdeBridgeTool` — one class's members reported as another's, and the same declarations
        // reported twice in one document. The file check above was written for exactly this case and
        // could not see it, because both classes are in the same file.
        //
        // The rule is textual and names no language: a declaration reported inside another must lie
        // inside it. Inheritance, traits, mixins and extensions differ everywhere; containment does
        // not.
        if (value != null && within != null) {
            val range = value.textRange ?: return emptyList()
            if (!within.contains(range)) return emptyList()
        }

        val node = value?.let { node(element, it, file) }
        return if (node != null) {
            listOf(node)
        } else {
            element.children.flatMap { declarations(it, file, within) }
        }
    }

    private fun node(
        element: TreeElement,
        value: PsiElement,
        file: PsiFile,
    ): SymbolMapping.Node<PsiAnchor>? {
        // Only elements the language reports as named are addressable by a locator. The name is the
        // language's own; a row's presentation text is a rendering for a human — Java shows a field
        // as `r: Runnable = new Runnable() {...}` — and using it would invent a name rather than
        // report one.
        val named = value as? PsiNameIdentifierOwner ?: return null
        val name = named.name ?: return null
        val declaration = value.textRange ?: return null
        val identifier = PsiSymbols.identifierRange(named, declaration) ?: return null
        if (value is PsiFile) return null

        return Node(
            name = name,
            kind = SymbolKindMapper.classify(value),
            declarationType = declarationType(value),
            declarationStart = declaration.startOffset,
            declarationEnd = declaration.endOffset,
            selectionStart = identifier.startOffset,
            selectionEnd = identifier.endOffset,
            anchor = SmartPointerManager.getInstance(value.project)
                .createSmartPsiElementPointer(value),
            children = element.children.flatMap { declarations(it, file, declaration) },
        )
    }


    /**
     * The IDE's own name for a declaration's syntactic form.
     *
     * `elementType` is what the language's parser labelled the node — `CLASS`, `FUNCTION_DECLARATION`,
     * `PhpClass` — and every language has one. It is never interpreted here, only carried, so the
     * adapter distinguishes a field from a method without knowing what either is.
     */
    private fun declarationType(element: PsiElement): String? =
        element.node?.elementType?.toString()?.takeIf { it.isNotBlank() }
    private class Node(
        override val name: String,
        override val kind: SymbolKind,
        override val declarationType: String?,
        override val declarationStart: Int,
        override val declarationEnd: Int,
        override val selectionStart: Int,
        override val selectionEnd: Int,
        override val anchor: PsiAnchor,
        override val children: List<SymbolMapping.Node<PsiAnchor>>,
    ) : SymbolMapping.Node<PsiAnchor>
}
