package com.idebridge.jetbrains.platform

import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.refactoring.RefactoringFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * What the platform can do about safe delete, recorded because the answer is not what it looked
 * like — and deliberately not wired to anything.
 *
 * ADR-0028 refused `extractMethod`, `inline`, `move` and `changeSignature` because the only route to
 * them drives a dialog. Safe delete was never examined, and `RefactoringFactory` — the class this
 * adapter already uses for headless renames — turns out to offer `createSafeDelete(PsiElement[])`.
 *
 * That does **not** make it a feature. `TASK.md` §29 lists safe delete as explicitly outside the
 * MVP, so no protocol method exposes it and none should be added here. These tests exist so the
 * exclusion stays legible as the product decision it is, rather than hardening over time into a
 * belief that the IDE cannot do it — the ADR now says as much in its addendum, and a claim about a
 * platform is worth more when something runs it.
 *
 * The measurement that matters is the separation: `findUsages()` reports what would break without
 * touching the file, which is the whole difference between a safe delete and a delete.
 */
class SafeDeleteSurfaceTest : BasePlatformTestCase() {

    private fun declaration(file: PsiFile, name: String): PsiElement =
        PsiTreeUtil.findChildrenOfType(file, PsiNameIdentifierOwner::class.java)
            .first { it.name == name }

    fun `test the refactoring object exposes a usage query separate from execution`() {
        val file = myFixture.configureByText(
            "Service.java",
            """
            class Service {
                private void unused() {}
            }
            """.trimIndent(),
        )
        val refactoring = RefactoringFactory.getInstance(project)
            .createSafeDelete(arrayOf(declaration(file, "unused")))

        val methods = refactoring.javaClass.methods
            .map { "${it.name}(${it.parameterTypes.joinToString { p -> p.simpleName }})" }
            .filter { it.startsWith("findUsages") || it.startsWith("run") || it.startsWith("setPreview") }
            .sorted()
        println("safe delete offers: $methods")

        assertTrue(
            "a usage query is what makes this safe rather than just a delete: $methods",
            methods.any { it.startsWith("findUsages(") },
        )
    }

    fun `test it names the usages that block a deletion instead of deleting`() {
        val file = myFixture.configureByText(
            "Service.java",
            """
            class Service {
                private void used() {}

                void caller() {
                    used();
                }
            }
            """.trimIndent(),
        )
        val target = declaration(file, "used")
        val refactoring = RefactoringFactory.getInstance(project).createSafeDelete(arrayOf(target))

        val usages = refactoring.findUsages()

        println("blocking usages: ${usages.size} -> ${usages.map { it.element?.text }}")
        assertTrue("the call site must be reported as a usage", usages.isNotEmpty())
        assertTrue("querying usages must not delete anything", target.isValid)
        assertTrue("the declaration must still be in the file", file.text.contains("void used()"))
    }

    fun `test an unreferenced declaration reports nothing blocking`() {
        val file = myFixture.configureByText(
            "Service.java",
            """
            class Service {
                private void unused() {}
            }
            """.trimIndent(),
        )
        val refactoring = RefactoringFactory.getInstance(project)
            .createSafeDelete(arrayOf(declaration(file, "unused")))

        assertEquals(
            "nothing references it, so nothing should block its removal",
            0,
            refactoring.findUsages().size,
        )
    }
}
