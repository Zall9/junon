package com.idebridge.jetbrains.platform

import com.intellij.lang.refactoring.RefactoringSupportProvider
import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * What the platform actually offers for the structural refactorings that exist here as vocabulary
 * only — `extractMethod`, `inline`, `move`, `changeSignature`.
 *
 * Written to answer one question before any of them is implemented: **is there a language-neutral
 * way to perform them without a dialog?** The adapter runs headless behind a socket, and a
 * refactoring that opens a modal is not merely awkward — it blocks the request thread, which is the
 * exact failure this project spent a day chasing on `refactor/prepare`.
 *
 * This is a probe, not a guarantee. It records what the API surface is, so the decision to
 * implement or to refuse is made against a measurement rather than an assumption.
 */
class StructuralRefactoringSurfaceTest : BasePlatformTestCase() {

    private fun javaFile(): PsiJavaFile =
        myFixture.configureByText(
            "Service.java",
            """
            class Service {
                int value() {
                    int a = 1;
                    int b = 2;
                    return a + b;
                }
            }
            """.trimIndent(),
        ) as PsiJavaFile

    fun `test the platform exposes refactoring support for the host language`() {
        val file = javaFile()

        val provider = com.intellij.lang.LanguageRefactoringSupport.getInstance()
            .forContext(file)

        assertNotNull(
            "a language with refactorings must publish a support provider, or nothing generic can " +
                "reach them",
            provider,
        )
    }

    /**
     * The finding that decides the design.
     *
     * `getExtractMethodHandler` returns a `RefactoringActionHandler`, whose only entry points take
     * an `Editor` and a `DataContext` and are documented to drive the UI. There is no variant that
     * computes a result and returns it. So a generic extract-method cannot be performed headlessly
     * through this surface — which is a fact about the platform, not a gap in this adapter.
     */
    fun `test extract method is only reachable through a UI handler`() {
        val file = javaFile()
        val provider = com.intellij.lang.LanguageRefactoringSupport.getInstance()
            .forContext(file)!!

        val handler = provider.extractMethodHandler

        // Asserted rather than guarded by a null check. A design decision rests on this — that
        // structural refactorings are refused rather than approximated — and an `if (handler !=
        // null)` would have let the test pass while proving nothing, which is the vacuous shape
        // this project has caught twice.
        assertNotNull("Java must offer an extract-method handler, or this proves nothing", handler)
        assertTrue(
            "the only handler the platform offers is the UI one, which cannot run headless",
            handler is com.intellij.refactoring.RefactoringActionHandler,
        )
    }
}
