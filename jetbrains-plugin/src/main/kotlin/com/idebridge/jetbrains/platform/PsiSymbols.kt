package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.symbol.SymbolKindMapper
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.SmartPointerManager
import com.intellij.psi.SmartPsiElementPointer
import com.intellij.psi.util.PsiTreeUtil

/** What the platform can resolve back to a declaration in O(1), across PSI rebuilds. */
public typealias PsiAnchor = SmartPsiElementPointer<out PsiElement>

/**
 * Describes any file's declarations, in any JetBrains IDE.
 *
 * Discovery is language-agnostic on purpose: `PsiNameIdentifierOwner` is implemented by every
 * language's PSI, so a declaration's name, identifier and extent come from the host IDE's own
 * parser — CLion's for C++, PhpStorm's for PHP — with nothing anticipated here. Classification is
 * the part that cannot be generic, so it is delegated to [SymbolKindMapper], which the host IDE
 * contributes.
 *
 * Nesting follows the PSI tree: a declaration's children are the named declarations inside it, at
 * any depth, with intermediate unnamed nodes (blocks, statements) traversed through rather than
 * reported. That is what makes a method inside a class come back as its child in every language,
 * without knowing what "class" means in any of them.
 *
 * Callers must already hold a read action.
 */
public object PsiSymbols {

    /**
     * Top-level declarations of a file, nested.
     *
     * A declaration the IDE reports without a name — an anonymous class, an initializer block, a
     * lambda — is skipped rather than given an invented name. It is not addressable by a locator, so
     * emitting one would produce a symbol that can never be relocated. What it *contains* is still
     * reported, one level up: an unnameable declaration cannot take a nameable one with it.
     */
    public fun declarations(file: PsiFile): List<SymbolMapping.Node<PsiAnchor>> =
        // The IDE's own structure model first: it is the language plugin's answer to what contains
        // what, and it is right in cases a generic walk is not. This walk remains for languages
        // that ship no structure view, where finding named declarations is still better than
        // reporting none.
        StructureViewSymbols.declarations(file) ?: childDeclarations(file)

    private fun childDeclarations(parent: PsiElement): List<SymbolMapping.Node<PsiAnchor>> =
        namedDescendants(parent).mapNotNull { node(it) }

    /**
     * The nearest named declarations below [parent], not their descendants.
     *
     * Walking to the nearest named element rather than to a fixed depth is what keeps the tree
     * shaped like the language: a method wrapped in a PHP class body, a Kotlin function inside an
     * object, and a C++ member all sit one level down even though the PSI puts different unnamed
     * nodes in between.
     */
    private fun namedDescendants(parent: PsiElement): List<PsiNameIdentifierOwner> {
        val found = mutableListOf<PsiNameIdentifierOwner>()
        for (child in parent.children) {
            // The name is what makes a declaration addressable, and it is the language's to give.
            // Whether the text also spells the name out is a separate question, answered by
            // [identifierRange] — keying this boundary on the identifier instead would step over a
            // declaration the language does name and hoist its members into its container.
            if (child is PsiNameIdentifierOwner && child.name != null) {
                found.add(child)
            } else {
                found.addAll(namedDescendants(child))
            }
        }
        return found
    }

    private fun node(element: PsiNameIdentifierOwner): SymbolMapping.Node<PsiAnchor>? {
        val name = element.name ?: return null
        val declaration = element.textRange ?: return null
        val identifier = identifierRange(element, declaration) ?: return null
        // A file that declares itself — some languages model the file as a named element — would
        // otherwise nest every other declaration under a duplicate of itself.
        if (element is PsiFile) return null

        return PsiNode(
            name = name,
            kind = SymbolKindMapper.classify(element),
            declarationType = declarationType(element),
            declarationStart = declaration.startOffset,
            declarationEnd = declaration.endOffset,
            selectionStart = identifier.startOffset,
            selectionEnd = identifier.endOffset,
            anchor = SmartPointerManager.getInstance(element.project)
                .createSmartPsiElementPointer(element),
            children = childDeclarations(element),
        )
    }

    /**
     * What a rename would replace, inside [declaration]: the identifier the language spells out, or
     * an empty range where it spells none. `null` when the platform places the declaration somewhere
     * this adapter cannot describe.
     *
     * Some declarations are named without being spelled: Kotlin's `companion object` is called
     * `Companion` by the language, and PSI reports that name with no `nameIdentifier`, because no
     * text says it. Such a declaration is real and worth reporting — it holds members a consumer
     * asked for — but there is no identifier text to point at, and inventing one would be worse than
     * the omission it replaces.
     *
     * An empty range at the offset the platform navigates the caret to is what says that without
     * inventing anything. It locates the declaration, satisfies the protocol's requirement that the
     * selection lie inside the declaration, and claims no text as a name — measured on 2026-08-09 to
     * be a companion's `object` keyword, the token a name would follow if one were written, and past
     * the annotations and modifiers where the declaration itself starts.
     * `IntelliJRename` refuses an element with no identifier, so nothing tries to rewrite that empty
     * span; a caller learns the declaration is unnameable by being refused, not by being told a lie.
     */
    internal fun identifierRange(
        element: PsiNameIdentifierOwner,
        declaration: TextRange,
    ): TextRange? {
        element.nameIdentifier?.textRange?.let { return it }
        // The platform's own caret target. It is inside the declaration for every construct measured,
        // and the check is what keeps that a fact rather than an assumption: a selection outside its
        // declaration would otherwise fail the whole document's mapping.
        val anchor = element.textOffset
        return TextRange(anchor, anchor).takeIf { declaration.contains(it) }
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
    private class PsiNode(
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

    /** Kept so callers can find a declaration by offset without knowing the language. */
    public fun declarationAt(file: PsiFile, offset: Int): PsiNameIdentifierOwner? =
        PsiTreeUtil.findElementOfClassAtOffset(file, offset, PsiNameIdentifierOwner::class.java, false)
}
