package com.idebridge.jetbrains.platform

import com.intellij.refactoring.RefactoringFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * What the platform offers headlessly, measured rather than assumed.
 *
 * ADR-0028 refused the structural refactorings on the grounds that the only language-neutral route
 * to them is `RefactoringSupportProvider`, whose handlers take an `Editor` and a `DataContext` and
 * drive a dialog. That measurement was real but incomplete: it never asked what
 * `RefactoringFactory` offers — the very class this adapter already uses to perform renames without
 * any UI at all.
 *
 * This test prints and pins that surface, so the refusal rests on the whole platform rather than on
 * the first place looked.
 */
class RefactoringFactorySurfaceTest : BasePlatformTestCase() {

    fun `test the factory that already performs our headless rename`() {
        val methods = RefactoringFactory::class.java.methods
            .filter { it.declaringClass == RefactoringFactory::class.java }
            .map { method -> "${method.name}(${method.parameterTypes.joinToString { it.simpleName }})" }
            .sorted()

        // Printed so the surface is visible in the run log; a refusal recorded in an ADR should be
        // checkable by whoever reads it, not taken on trust.
        println("RefactoringFactory offers ${methods.size} methods:")
        methods.forEach { println("  $it") }

        // The one we already depend on. If it disappears, `IntelliJRename` breaks, and this says so
        // in one line rather than through a compile error in an unrelated file.
        assertTrue(
            "createRename is the headless entry point IntelliJRename is built on",
            methods.any { it.startsWith("createRename(") },
        )
    }
}
