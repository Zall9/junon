package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.util.treeView.smartTree.TreeElement
import com.intellij.navigation.ItemPresentation
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * A declaration is reported under the declaration that contains it, and under no other.
 *
 * Found by running a real PyCharm, not by a failing test. `IdeStatusTool` declares one method,
 * `apply`, and the symbol tree offered four: the three it inherits arrived beneath it carrying
 * their base class's ranges. Two consequences, both bad. The same three declarations appeared twice
 * in one document, and "IdeStatusTool._client" addressed text inside `IdeBridgeTool` — so an agent
 * editing that member would have changed every subclass instead of one.
 *
 * `StructureViewSymbols` already refused inherited members whose base class lives in **another**
 * file. That guard was written for this exact problem and could not see this case, because both
 * classes are in the same file.
 *
 * **The first version of this test was vacuous, and an isolated mutation said so**: four Java
 * assertions passed identically with the containment rule present and removed, because Java's
 * structure model does not offer inherited rows at all. Only Python's did, and Python is not
 * available to this fixture. So the rule is exercised where it actually lives — on the shape of the
 * tree. The PSI elements below are real; only the nesting is authored, which is precisely the thing
 * that differs between languages.
 */
class InheritedMembersTest : BasePlatformTestCase() {

    /** A structure row over a real PSI element, nested however the test needs. */
    private class Row(
        private val element: PsiElement,
        private val kids: List<Row> = emptyList(),
    ) : StructureViewTreeElement {
        override fun getValue(): Any = element
        override fun getChildren(): Array<TreeElement> = kids.toTypedArray<TreeElement>()
        override fun getPresentation(): ItemPresentation =
            com.intellij.ide.projectView.PresentationData()
        override fun navigate(requestFocus: Boolean) = Unit
        override fun canNavigate(): Boolean = false
        override fun canNavigateToSource(): Boolean = false
    }

    private val source = """
        class Base {
            void inherited() {}
        }

        class Derived extends Base {
            void own() {}
        }
    """.trimIndent()

    private fun file(): PsiJavaFile = myFixture.configureByText("Demo.java", source) as PsiJavaFile

    private fun classNamed(file: PsiJavaFile, name: String): PsiClass =
        file.classes.single { it.name == name }

    private fun names(file: PsiFile, root: Row): List<String> =
        StructureViewSymbols.declarations(root, file).flatMap { node ->
            listOf(node.name) + node.children.map { it.name }
        }

    fun `test a member declared outside its parent is dropped`() {
        val file = file()
        val derived = classNamed(file, "Derived")
        val inheritedElsewhere = classNamed(file, "Base").methods.single { it.name == "inherited" }

        // Exactly what PyCharm produced: a row for `Derived` whose children include a method that
        // lives inside `Base`.
        val tree = Row(
            derived,
            listOf(
                Row(derived.methods.single { it.name == "own" }),
                Row(inheritedElsewhere),
            ),
        )

        assertEquals(
            "`inherited` is declared in Base and must not be reported inside Derived",
            listOf("Derived", "own"),
            names(file, tree),
        )
    }

    fun `test a member declared inside its parent is kept`() {
        val file = file()
        val base = classNamed(file, "Base")

        val tree = Row(base, listOf(Row(base.methods.single { it.name == "inherited" })))

        assertEquals(listOf("Base", "inherited"), names(file, tree))
    }

    fun `test the rule survives a row the adapter cannot address`() {
        // A transparent row — one carrying no addressable declaration — must pass the containment
        // constraint down rather than lose it, or a member could re-enter through a wrapper.
        val file = file()
        val derived = classNamed(file, "Derived")
        val inheritedElsewhere = classNamed(file, "Base").methods.single { it.name == "inherited" }

        val grouping = object : TreeElement {
            override fun getChildren(): Array<TreeElement> = arrayOf(Row(inheritedElsewhere))
            override fun getPresentation(): ItemPresentation =
                com.intellij.ide.projectView.PresentationData()
        }
        val tree = Row(derived, emptyList())

        val throughWrapper = StructureViewSymbols.declarations(
            grouping,
            file,
            derived.textRange,
        )

        assertTrue(
            "a wrapper must not launder a declaration into a parent that does not contain it",
            throughWrapper.isEmpty(),
        )
        assertEquals(listOf("Derived"), names(file, tree))
    }

    fun `test the whole-file walk still reports what the IDE gives`() {
        // The guard must not cost the ordinary case: both classes and both their members.
        val file = file()
        val drafts = SymbolMapping.mapDocument(
            StructureViewSymbols.declarations(file) ?: error("no structure model"),
            "file:///demo/Demo.java",
            LineIndex(source),
        )

        assertEquals(listOf("Base", "Derived"), drafts.map { it.locator.name })
        assertEquals(listOf("inherited"), drafts[0].children.map { it.locator.name })
        assertEquals(listOf("own"), drafts[1].children.map { it.locator.name })
    }
}
