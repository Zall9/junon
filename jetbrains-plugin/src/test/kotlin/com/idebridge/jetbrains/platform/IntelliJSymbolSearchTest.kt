package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.service.AdapterBackend
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.navigation.ChooseByNameContributor
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.testFramework.ExtensionTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * What `workspace/searchSymbols` may leave out, and what it may not.
 *
 * The search route reads the IDE's own "Go to Symbol" index, and until 2026-08-09 it dropped every
 * declaration whose name the language supplies without the text spelling it — the same rule, and the
 * same defect, that ADR-0030 records for `document/getSymbols`. Measured then: the index offers the
 * name `Companion` for a Kotlin companion object, and a search for it returned an empty list with
 * `truncated = false`, so the response both omitted the hit and claimed to be complete.
 *
 * That combination is what these tests exist to prevent. ADR-0017 permits dropping an in-scope hit
 * IDEBP cannot represent, but requires saying so through `truncated`; a declaration named without
 * being spelled is representable, so it is reported instead of counted as a loss.
 *
 * Kotlin is incidental — it is simply a language this IDE parses whose PSI has such a declaration.
 * Nothing in the production path names it.
 */
class IntelliJSymbolSearchTest : BasePlatformTestCase() {

    private val source = """
        class Service {
            companion object {
                fun run() {}
            }
        }

        class Registry {
            companion object Factory {
                fun make() {}
            }
        }
    """.trimIndent()

    fun `test a declaration the language names without spelling is searchable`() {
        myFixture.configureByText("Service.kt", source)

        val found = IntelliJSymbolSearch.search(project, "Companion", 50)
        val here = found.elements.filter { it.containingFile?.name == "Service.kt" }

        assertEquals(
            "the index offers this name, so the search must answer with it",
            listOf("Companion"),
            here.map { it.name },
        )
        // Nothing was removed, so the completeness the response claims is true.
        assertFalse("nothing was dropped, so nothing is truncated", found.truncated)
    }

    fun `test a spelled name is unaffected`() {
        myFixture.configureByText("Service.kt", source)

        val found = IntelliJSymbolSearch.search(project, "Factory", 50)
        val here = found.elements.filter { it.containingFile?.name == "Service.kt" }

        assertEquals(listOf("Factory"), here.map { it.name })
    }

    /**
     * A contributor that answers with [decoys] names nothing will match, then [target].
     *
     * This is the shape a real IDE has and a fixture never does: the platform's contributors return
     * the JDK's and Kotlin's own names even when asked for project items only, so the project's own
     * names come *after* thousands that no query of a consumer's will match.
     */
    private fun floodedContributor(decoys: Int, target: String) = object : ChooseByNameContributor {
        override fun getNames(project: Project, includeNonProjectItems: Boolean): Array<String> =
            Array(decoys) { "zzDecoy$it" } + target

        override fun getItemsByName(
            name: String,
            pattern: String,
            project: Project,
            includeNonProjectItems: Boolean,
        ): Array<NavigationItem> {
            val file = myFixture.file ?: return emptyArray()
            val declaration = PsiTreeUtil
                .findChildrenOfType(file, PsiNameIdentifierOwner::class.java)
                .firstOrNull { it.name == name }
            return if (declaration is NavigationItem) arrayOf(declaration) else emptyArray()
        }
    }

    /**
     * The defect a real IDE showed and no test could: measured 2026-08-10 against a running
     * IntelliJ, every query returned nothing while reporting `truncated`, because the budget counted
     * names *read* and the library names spent it before the scan reached the project's own.
     */
    fun `test a flood of unmatched names does not starve the project's own`() {
        myFixture.configureByText("Service.kt", "class Marker {\n    fun deep() {}\n}")
        ExtensionTestUtil.maskExtensions(
            ChooseByNameContributor.SYMBOL_EP_NAME,
            listOf(floodedContributor(IntelliJSymbolSearch.MAX_RESOLVED_NAMES + 10, "Marker")),
            testRootDisposable,
        )

        val found = IntelliJSymbolSearch.search(project, "Marker", 50)

        assertEquals(
            "the name is past the old budget, and reading names is not what costs",
            listOf("Marker"),
            found.elements.map { it.name },
        )
        // And the answer is complete, because nothing was left unresolved.
        assertFalse("nothing was skipped, so nothing is truncated", found.truncated)
    }

    fun `test the budget still bounds the work, and says so`() {
        myFixture.configureByText("Service.kt", "class Marker {\n    fun deep() {}\n}")
        // Every name matches this time, so every one of them costs a resolution.
        ExtensionTestUtil.maskExtensions(
            ChooseByNameContributor.SYMBOL_EP_NAME,
            listOf(
                object : ChooseByNameContributor {
                    override fun getNames(project: Project, includeNonProjectItems: Boolean) =
                        Array(IntelliJSymbolSearch.MAX_RESOLVED_NAMES + 10) { "Marker$it" }

                    override fun getItemsByName(
                        name: String,
                        pattern: String,
                        project: Project,
                        includeNonProjectItems: Boolean,
                    ): Array<NavigationItem> = emptyArray()
                },
            ),
            testRootDisposable,
        )

        val found = IntelliJSymbolSearch.search(project, "Marker", 50)

        // Nothing resolvable came back, and the ceiling is reported rather than presented as a
        // complete answer — the honest half of the old behaviour, kept.
        assertTrue("the ceiling must be reported", found.truncated)
        assertTrue("nothing was resolvable here", found.elements.isEmpty())
    }

    fun `test the route reports the unspelled name with an empty selection range`() {
        myFixture.configureByText("Service.kt", source)

        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")
        val backend = AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = "session_search_test",
            workspaceEpoch = model.currentEpoch,
            tracker = DaemonAnalysisTracker(project),
        )

        // `Found` rather than a bare result: the route refuses with `IndexNotReady` while the IDE is
        // still indexing, and unwrapping here is what keeps that refusal from being mistaken for an
        // empty answer (ADR-0034).
        val outcome = backend.searchSymbols(
            WorkspaceSearchSymbolsParams(workspace.workspaceId, "Companion", limit = 50),
        )
        val result = (outcome as? AdapterRouter.SearchOutcome.Found)?.result
            ?: error("the search must be answered for its own workspace, got: $outcome")

        // The whole route, not just the index reader: the mapping had its own identifier requirement,
        // so a fix in one place would have left the other refusing.
        val companion = result.symbols.single { it.locator.name == "Companion" }
        val selection = companion.locator.selectionRange
        assertEquals(
            "there is no identifier text to claim",
            selection.start,
            selection.end,
        )
        assertTrue(
            "the declaration itself still has an extent",
            companion.range.end.line > companion.range.start.line ||
                companion.range.end.character > companion.range.start.character,
        )

        // And a spelled identifier still arrives as one, through the same mapping.
        val spelledOutcome = backend.searchSymbols(
            WorkspaceSearchSymbolsParams(workspace.workspaceId, "Factory", limit = 50),
        )
        val spelled = (spelledOutcome as? AdapterRouter.SearchOutcome.Found)?.result
            ?: error("the search must be answered for its own workspace, got: $spelledOutcome")
        val factory = spelled.symbols.single { it.locator.name == "Factory" }
        val identifier = factory.locator.selectionRange
        assertEquals(
            "Factory".length,
            identifier.end.character - identifier.start.character,
        )
    }
}
