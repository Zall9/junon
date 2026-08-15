package com.idebridge.jetbrains.platform

import com.intellij.psi.ElementDescriptionUtil
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.usageView.UsageViewTypeLocation

/**
 * Is there a language-neutral source of symbol kind, or is `unknown` the honest answer?
 *
 * `SymbolKindMapper` is an extension point with no implementations, so `kind` is `unknown` for every
 * symbol of every language and always will be — nothing outside this repository knows the extension
 * point exists. `declarationType` routes around that for relocation, but it carries each parser's
 * own vocabulary (`METHOD` in Java, `FUN` in Kotlin), which cannot answer a caller asking in a
 * shared vocabulary.
 *
 * This measures the remaining candidate: the type string the platform asks each language for when
 * it renders Find Usages. If it normalises across languages it is the IDE's own classification and
 * we may carry it; if it does not, `unknown` stands and callers must be refused by name.
 */
class SymbolKindSourceTest : BasePlatformTestCase() {

    private fun report(fileName: String, source: String) {
        val file: PsiFile = myFixture.configureByText(fileName, source)
        println("--- $fileName ---")
        for (element in PsiTreeUtil.findChildrenOfType(file, PsiNameIdentifierOwner::class.java)) {
            val name = element.name ?: continue
            println(
                "  name=$name" +
                    " | elementType=${element.node?.elementType}" +
                    " | findUsagesType=${describe(element)}",
            )
        }
    }

    private fun describe(element: PsiElement): String =
        runCatching {
            ElementDescriptionUtil.getElementDescription(element, UsageViewTypeLocation.INSTANCE)
        }.getOrElse { "<threw ${it::class.simpleName}>" }

    fun `test what each language calls its declarations`() {
        report(
            "Service.java",
            """
            class Service {
                int value;

                int value() {
                    return value;
                }
            }
            """.trimIndent(),
        )
        report(
            "Service.kt",
            """
            class Service {
                val value = 1

                fun value() = value
            }
            """.trimIndent(),
        )
    }

    /**
     * The constructs whose LSP name is more than one word, or whose category is easy to assume.
     *
     * `typeParameter` and `enumMember` are single words in the protocol's vocabulary; if the
     * platform spells them "type parameter" and "enum constant" then matching is not the plain
     * lookup the two-word cases make it look like, and any bridging would be an authored guess.
     * Better to find that out here than to write the guess first.
     */
    fun `test what it calls the constructs whose names are least obvious`() {
        report(
            "Shapes.java",
            """
            interface Shape {}

            enum Colour { RED, GREEN }

            class Box<T> implements Shape {
                static final int LIMIT = 3;

                Box() {}

                void use() {
                    int local = 1;
                }
            }
            """.trimIndent(),
        )
        report(
            "Shapes.kt",
            """
            interface Shape

            enum class Colour { RED, GREEN }

            object Registry

            class Box<T> : Shape {
                companion object {
                    const val LIMIT = 3
                }
            }
            """.trimIndent(),
        )
    }
}
