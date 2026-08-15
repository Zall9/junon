package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.idebridge.jetbrains.document.DocumentModel
import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.edit.RenamePlanRegistry
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJNavigation
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.workspace.ReadinessModel
import com.idebridge.jetbrains.protocol.SymbolLocation
import com.idebridge.jetbrains.protocol.HierarchyRelation
import com.idebridge.jetbrains.protocol.SymbolHierarchyParams
import com.idebridge.jetbrains.protocol.Bookmark
import com.idebridge.jetbrains.protocol.TodoItem
import com.idebridge.jetbrains.protocol.WorkspaceListBookmarksParams
import com.idebridge.jetbrains.protocol.WorkspaceListBookmarksResult
import com.idebridge.jetbrains.protocol.WorkspaceSearchTodosParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchTodosResult
import com.idebridge.jetbrains.protocol.SymbolLocationsResult
import com.idebridge.jetbrains.protocol.SymbolResolveAtParams
import com.idebridge.jetbrains.protocol.SymbolResolveAtResult
import com.idebridge.jetbrains.protocol.SymbolTargetParams
import com.idebridge.jetbrains.platform.IntelliJSymbolSearch
import com.idebridge.jetbrains.platform.StructureViewSymbols
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsResult
import com.intellij.psi.SmartPointerManager
import com.idebridge.jetbrains.platform.IntelliJUndo
import com.idebridge.jetbrains.protocol.UndoToken
import com.idebridge.jetbrains.protocol.WorkspaceUndoParams
import com.idebridge.jetbrains.platform.IntelliJHierarchy
import com.idebridge.jetbrains.platform.IntelliJBookmarks
import com.idebridge.jetbrains.platform.IntelliJTodos
import com.idebridge.jetbrains.platform.IntelliJDocumentEdits
import com.idebridge.jetbrains.platform.IntelliJDiagnostics
import com.idebridge.jetbrains.platform.IntelliJEditScheduler
import com.idebridge.jetbrains.platform.IntelliJRename
import com.idebridge.jetbrains.platform.PsiSymbols
import com.idebridge.jetbrains.platform.PsiAnchor
import com.idebridge.jetbrains.protocol.ChangeSummary
import com.idebridge.jetbrains.protocol.Atomicity
import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotResult
import com.idebridge.jetbrains.protocol.DocumentDiagnostics
import com.idebridge.jetbrains.protocol.DocumentContent
import com.idebridge.jetbrains.protocol.DocumentGetRevisionResult
import com.idebridge.jetbrains.protocol.DocumentGetSymbolsResult
import com.idebridge.jetbrains.protocol.DocumentRevisionPrecondition
import com.idebridge.jetbrains.protocol.EditOperation
import com.idebridge.jetbrains.protocol.EditPlan
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.Guarantee
import com.idebridge.jetbrains.protocol.ModificationResult
import com.idebridge.jetbrains.protocol.RefactorPrepareParams
import com.idebridge.jetbrains.protocol.ModifiedDocument
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameResult
import com.idebridge.jetbrains.protocol.Workspace
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanResult
import com.idebridge.jetbrains.symbol.SymbolHandleRegistry
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import java.time.Instant

/**
 * Answers daemon requests for one open project.
 *
 * This is the production counterpart of what the end-to-end test drives: the same mapping, plan and
 * scheduling pieces, resolving documents from the real VFS instead of a fixture. Requests arrive on
 * a background thread, so every PSI read is inside a `ReadAction` and every mutation goes through
 * the [IntelliJEditScheduler].
 */
public class AdapterBackend(
    private val project: Project,
    private val workspace: Workspace,
    private val adapterId: String,
    private val sessionId: String,
    private val workspaceEpoch: Int,
    private val tracker: DaemonAnalysisTracker,
) : AdapterRouter.Backend {

    private companion object {
        /** Mirrors the protocol defaults; a caller may ask for less, never for more. */
        const val DEFAULT_SEARCH_LIMIT = 200
        const val MAX_SEARCH_LIMIT = 1_000
    }

    /**
     * Announces a document this adapter changed, so the daemon can invalidate what depended on it.
     *
     * Set after construction because the connection does not exist yet when the backend is built —
     * the client is created *with* this backend. Left as a no-op until then, and in tests.
     *
     * TASK.md §12 requires a document change to invalidate the plans and handles concerned. This
     * adapter sent no document notification at all, so the daemon's plan store never learned about
     * edits the bridge itself performed: after applying one plan, another plan on the same file was
     * still live there, and only the adapter's own precondition check refused it (ADR-0038).
     *
     * Scoped to the edits this adapter makes. Text the user types is **not** forwarded — TASK.md §12
     * says the MVP need not send every text change, and a document listener with its own debounce is
     * a larger piece of work than this. What a consumer can rely on today is stated in DEMO.md
     * rather than left to be discovered.
     */
    @Volatile
    public var announceChange: (DocumentContent) -> Unit = {}

    private val handles = SymbolHandleRegistry<PsiAnchor>()
    /**
     * What a plan will perform when applied.
     *
     * A rename carries the engine's own prepared refactoring; a document operation carries only
     * its target, because the IDE recomputes it at apply time and doing so twice would be a
     * different edit from the one that was reviewed.
     */
    private sealed interface PreparedEdit {
        data class Rename(val prepared: IntelliJRename.Prepared) : PreparedEdit

        data class Document(val operation: EditOperation, val uri: String) : PreparedEdit

        /**
         * A quick fix, carried as the id the consumer chose rather than the action itself.
         *
         * Holding the `IntentionAction` across the two phases would pin an object whose document
         * may have moved on; re-resolving at apply time means a superseded offer is refused
         * instead of applied against text nobody reviewed.
         */
        data class QuickFix(val uri: String, val fixId: String) : PreparedEdit
    }

    private val plans = RenamePlanRegistry<PreparedEdit>()

    /**
     * Documents an applied plan touched, by undo token.
     *
     * The token is what makes undo scoped: without it the adapter would have to guess which
     * document to revert, and IntelliJ's own answer — the focused editor — can be a file the
     * plan never named.
     */
    private val undoable = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val scheduler = IntelliJEditScheduler(project)

    private fun handleContext() =
        SymbolHandleRegistry.Context(adapterId, sessionId, workspace.workspaceId, workspaceEpoch)

    private fun planContext() =
        RenamePlanRegistry.Context(sessionId, workspace.workspaceId, workspaceEpoch)

    /**
     * Any file the host IDE can parse.
     *
     * No language is named here: whichever IDE installed the plugin decides what it can parse, and
     * [PsiSymbols] reads declarations through interfaces every language's PSI implements.
     */
    private fun sourceFile(uri: String): PsiFile? {
        val virtualFile = VirtualFileManager.getInstance().findFileByUrl(uri) ?: return null
        return PsiManager.getInstance(project).findFile(virtualFile)
    }

    override fun documentSymbols(workspaceId: String, uri: String): AdapterRouter.SymbolsOutcome? {
        if (workspaceId != workspace.workspaceId) return null
        return ReadAction.compute<AdapterRouter.SymbolsOutcome?, RuntimeException> {
            val file = sourceFile(uri) ?: return@compute null
            val text = file.text
            val drafts = SymbolMapping.mapDocument(
                PsiSymbols.declarations(file),
                uri,
                LineIndex(text),
            )
            // Both conditions, and neither alone. No structure view means no language plugin claims
            // the file — under a build without JavaScript support a `.ts` is opened by TextMate,
            // which displays it without understanding it. An empty result alone would condemn an
            // empty file of a perfectly supported language. Together they say: this IDE has nothing
            // to describe here and never will.
            if (drafts.isEmpty() && !StructureViewSymbols.describes(file)) {
                return@compute AdapterRouter.SymbolsOutcome.LanguageUnsupported
            }

            val content = DocumentModel().read(
                workspace,
                uri,
                DocumentModel.Source.Buffer(text, isDirty = false),
                languageId = file.language.id.lowercase(),
            )
            if (content !is DocumentModel.Outcome.Ready) return@compute null
            AdapterRouter.SymbolsOutcome.Ready(
                DocumentGetSymbolsResult(
                    document = content.content.document,
                    symbols = handles.materializeDocument(drafts, uri, handleContext()),
                ),
            )
        }
    }

    override fun searchSymbols(
        params: WorkspaceSearchSymbolsParams,
    ): AdapterRouter.SearchOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        // The name index is what this route reads, so while the IDE is still building it the honest
        // answer is a retriable refusal. An empty list would say "no such symbol" about the one thing
        // nobody knows yet (ADR-0034).
        if (IntelliJProjectSnapshot.indexState(project) != ReadinessModel.IndexState.SMART) {
            return AdapterRouter.SearchOutcome.IndexNotReady
        }
        // A different state, and not a transient one: a project whose files sit in no source root is
        // indexed for nothing, and no retry will change that. It is answered rather than refused —
        // the answer is simply flagged incomplete, and the person who can fix it is told.
        val unindexed = !IntelliJProjectSnapshot.hasSourceRoots(project)
        if (unindexed) IndexHealthNotifier.warnNoSourceRoots(project)
        val limit = (params.limit ?: DEFAULT_SEARCH_LIMIT).coerceAtMost(MAX_SEARCH_LIMIT)

        return ReadAction.compute<AdapterRouter.SearchOutcome, RuntimeException> {
            val found =
                IntelliJSymbolSearch.search(project, params.query, limit, params.kinds?.toSet())
            // A hit this adapter cannot describe is a hit the workspace holds and the response does
            // not. ADR-0017 requires saying so: it exempts scope filtering from `truncated` and
            // nothing else, and until 2026-08-10 every case below was dropped in silence, leaving a
            // partial answer indistinguishable from a complete one.
            var unrepresentable = false
            val drafts = found.elements.mapNotNull { element ->
                val file = element.containingFile
                val uri = file?.virtualFile?.url
                if (uri == null) {
                    unrepresentable = true
                    return@mapNotNull null
                }
                // A hit outside every registered root is dropped here: the daemon answers one
                // it cannot authorise by closing the session. This one is **not** truncation — scope
                // is a decision about what was asked for, not an admission of something withheld.
                if (!withinWorkspace(uri)) return@mapNotNull null
                val declaration = element.textRange
                if (declaration == null) {
                    unrepresentable = true
                    return@mapNotNull null
                }
                // The rule document symbols read, so one route cannot know a declaration the other
                // denies: the spelled identifier, or an empty range at the platform's own anchor
                // where the language spells none (ADR-0030).
                val identifier = PsiSymbols.identifierRange(element, declaration)
                if (identifier == null) {
                    unrepresentable = true
                    return@mapNotNull null
                }
                val index = LineIndex(file.text)
                if (!index.covers(declaration.startOffset, declaration.endOffset)) {
                    unrepresentable = true
                    return@mapNotNull null
                }
                val name = element.name
                if (name == null) {
                    unrepresentable = true
                    return@mapNotNull null
                }
                SymbolHandleRegistry.Draft<PsiAnchor>(
                    locator = SymbolMapping.createLocator(
                        documentUri = uri,
                        name = name,
                        kind = com.idebridge.jetbrains.symbol.SymbolKindMapper.classify(element),
                        selectionRange = index.range(identifier.startOffset, identifier.endOffset),
                        containerName = null,
                        declarationType = element.node?.elementType?.toString(),
                    ),
                    range = index.range(declaration.startOffset, declaration.endOffset),
                    anchor = SmartPointerManager.getInstance(project)
                        .createSmartPsiElementPointer<com.intellij.psi.PsiElement>(element),
                )
            }
            // Refusing here was tried and reverted. `UnindexedProjectTest` records the reason: an
            // unindexed search is answered, with `truncated` carrying the incompleteness. That is
            // not the same situation as diagnostics, where the identical flag also means "analysis
            // is still running" — a consumer polling on it there is behaving correctly and would
            // wait for ever, which is why *that* route refuses. Here nothing invites a retry, and
            // the flag already separates "nothing found" from "answer incomplete".
            AdapterRouter.SearchOutcome.Found(
                WorkspaceSearchSymbolsResult(
                    // Transient, not document handles: a search touching a file already explored
                    // must not revoke the handles that file handed out.
                    symbols = handles.materializeTransient(drafts, handleContext()),
                    // `unindexed` belongs here too: the workspace holds matches this response cannot
                    // carry, which is what the flag means, even though none were seen.
                    truncated = found.truncated || unrepresentable || unindexed,
                ),
            )
        }
    }

    override fun documentRead(workspaceId: String, uri: String): DocumentContent? {
        if (workspaceId != workspace.workspaceId) return null
        return ReadAction.compute<DocumentContent?, RuntimeException> {
            val file = sourceFile(uri) ?: return@compute null
            // Read from the in-memory document, not from disk: an editor with unsaved changes
            // is what the user is looking at, and answering with the saved bytes would hand a
            // consumer text nobody can see.
            val content = DocumentModel().read(
                workspace,
                uri,
                DocumentModel.Source.Buffer(file.text, isDirty = isDirty(file)),
                languageId = file.language.id.lowercase(),
            )
            (content as? DocumentModel.Outcome.Ready)?.content
        }
    }

    override fun documentRevision(
        workspaceId: String,
        uri: String,
    ): DocumentGetRevisionResult? {
        // The same read, with the text dropped. Computing it separately would risk reporting a
        // revision that never described any content this adapter served.
        val content = documentRead(workspaceId, uri) ?: return null
        return DocumentGetRevisionResult(content.document)
    }

    /**
     * Brings the IDE's view of [uris] up to date with the file system, where that is free of risk.
     *
     * An edit made outside the IDE reaches it only when the virtual file system refreshes, and that
     * can take a long time: measured on 2026-08-14, over ninety seconds after writing a bridged file
     * behind the IDE's back, `document/getRevision` still reported the old content. Every check in
     * this adapter reads that same stale view, so a plan could be applied over text that no longer
     * existed on disk — the failure the precondition check is there to prevent, arriving through the
     * one door it could not see.
     *
     * **Only files the editor holds unmodified.** IntelliJ raises a modal "reload from disk?" dialog
     * when a document is modified *and* its file changed underneath, and a dialog nobody is there to
     * answer blocks the IDE outright — measured, as every route timing out at exactly 30 s while
     * readiness still read `ready`. Skipping those files costs nothing: their in-memory text is what
     * the user is looking at and what the plan was prepared against, so it is the right thing to
     * check anyway.
     */
    private fun refreshUnmodifiedFromDisk(uris: List<String>) {
        val manager = FileDocumentManager.getInstance()
        val stale = ReadAction.compute<List<VirtualFile>, RuntimeException> {
            uris.mapNotNull { uri ->
                val file = VirtualFileManager.getInstance().findFileByUrl(uri) ?: return@mapNotNull null
                val document = manager.getDocument(file)
                if (document != null && manager.isDocumentUnsaved(document)) null else file
            }
        }
        if (stale.isEmpty()) return
        // Synchronous, and safe here: this runs on the serving thread, never the event thread.
        runCatching { VfsUtil.markDirtyAndRefresh(false, false, false, *stale.toTypedArray()) }
        ApplicationManager.getApplication().invokeAndWait {
            PsiDocumentManager.getInstance(project).commitAllDocuments()
        }
    }

    /** Whether the editor holds changes the file on disk does not have. */
    private fun isDirty(file: PsiFile): Boolean {
        val document = PsiDocumentManager.getInstance(project).getDocument(file) ?: return false
        return FileDocumentManager.getInstance().isDocumentUnsaved(document)
    }

    /**
     * Asks the IDE to analyse documents it has not analysed yet.
     *
     * The platform analyses a document that has an editor. Without this, a file the user never
     * opened is never inspected at all — the adapter would keep reporting `pending` for a question
     * the IDE was never asked, and an agent would wait for an answer that could not arrive.
     *
     * The editor is opened **without focus**: this is the adapter working, not the user being
     * navigated somewhere they did not ask to go. `IntelliJUndo` opens one for the same structural
     * reason — some platform work belongs to an editor, so there has to be one.
     *
     * Deliberately does not block on completion. Analysis is asynchronous, and a request that
     * waited for it would sit against the daemon's route timeout; the snapshot already reports
     * `pending` truthfully, so an early answer is honest and the next call carries the result.
     * Running inspections directly would avoid the wait but produce a different set — ADR-0027
     * rejected it because the daemon aggregates annotators and parser errors an inspection pass
     * omits.
     */
    private fun requestAnalysis(uris: List<String>) {
        if (uris.isEmpty()) return
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
            val analyzer = com.intellij.codeInsight.daemon.DaemonCodeAnalyzer.getInstance(project)
            val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
            for (uri in uris) {
                val file = ReadAction.compute<PsiFile?, RuntimeException> { sourceFile(uri) }
                    ?: continue
                val virtualFile = file.virtualFile ?: continue
                if (editors.getSelectedEditor(virtualFile) == null) {
                    runCatching { editors.openFile(virtualFile, false) }
                }
                runCatching { analyzer.restart(file) }
            }
        }
    }

    override fun diagnostics(
        workspaceId: String,
        documentUris: List<String>?,
    ): AdapterRouter.DiagnosticsOutcome? {
        if (workspaceId != workspace.workspaceId) return null
        val uris = documentUris.orEmpty()

        // A project with no source roots has no module and no SDK, so the analyser never runs and
        // never will. Left as an empty snapshot it looked exactly like analysis in progress, and a
        // consumer polling for completion polled for ever. The IDE user gets a notification about
        // this; until now the consumer — which is the party actually asking — got nothing.
        if (!IntelliJProjectSnapshot.hasSourceRoots(project)) {
            IndexHealthNotifier.warnNoSourceRoots(project)
            return AdapterRouter.DiagnosticsOutcome.NotAnalysable
        }

        requestAnalysis(uris)
        return ReadAction.compute<AdapterRouter.DiagnosticsOutcome, RuntimeException> {
            val documents = mutableListOf<DocumentDiagnostics>()
            var truncated = false
            for (uri in uris) {
                val file = sourceFile(uri) ?: continue
                val document = PsiDocumentManager.getInstance(project).getDocument(file) ?: continue
                val mapping = DiagnosticMapping.map(
                    IntelliJDiagnostics.highlights(project, document),
                    LineIndex(document.charsSequence),
                    tracker.state(file, document),
                )
                val content = DocumentModel().read(
                    workspace,
                    uri,
                    DocumentModel.Source.Buffer(file.text, isDirty = false),
                    languageId = file.language.id.lowercase(),
                )
                if (content !is DocumentModel.Outcome.Ready) continue
                documents.add(DocumentDiagnostics(content.content.document, mapping.diagnostics))
                truncated = truncated || mapping.truncated
            }
            AdapterRouter.DiagnosticsOutcome.Ready(
                DiagnosticsGetSnapshotResult(documents, Instant.now().toString(), truncated),
            )
        }
    }

    override fun prepareRename(params: RefactorPrepareRenameParams): AdapterRouter.RenameOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        val handle = params.symbol.handle
            ?: return AdapterRouter.RenameOutcome.Refused(ErrorCode.INVALID_IDENTIFIER)
        val resolved = handles.resolve(handle, handleContext())
            ?: return AdapterRouter.RenameOutcome.Refused(ErrorCode.STALE_SYMBOL)

        return ReadAction.compute<AdapterRouter.RenameOutcome, RuntimeException> {
            val element = resolved.anchor.element
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.STALE_SYMBOL)
            val file = sourceFile(resolved.documentUri)
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
            when (val outcome = IntelliJRename.prepare(project, element, params.newName)) {
                is IntelliJRename.Outcome.Refused ->
                    AdapterRouter.RenameOutcome.Refused(ErrorCode.PROVIDER_FAILED)

                is IntelliJRename.Outcome.Ready -> {
                    // One precondition per document the plan changes, not one for the declaration.
                    //
                    // A rename crosses files, and a change whose document carries no precondition
                    // would be applied against text nobody checked. The daemon refuses such a plan —
                    // and, because that is a contract violation, closes the adapter's session with
                    // it. Measured with a real IDE on 2026-08-14: every cross-file rename was
                    // refused `PROVIDER_FAILED` and took the whole connection down with it, which is
                    // how one unsupported refactoring looked like a broken bridge.
                    val changedFiles = outcome.prepared.changes.map { change ->
                        change.uri to sourceFile(change.uri)
                    }
                    val unreadable = changedFiles.any { (_, changed) -> changed == null }
                    if (unreadable) {
                        // Refuse here rather than emit a plan promising a document we cannot state
                        // the current contents of.
                        return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
                    }
                    val preconditions = changedFiles.map { (uri, changed) ->
                        DocumentRevisionPrecondition(
                            uri = uri,
                            contentHash = DocumentModel.hash(requireNotNull(changed).text),
                            workspaceEpoch = workspaceEpoch,
                        )
                    }.toMutableList()
                    if (preconditions.none { it.uri == resolved.documentUri }) {
                        // The engine counts the declaration among its changes, so this is defensive;
                        // if that ever stops being true the declaring document is still guarded.
                        preconditions.add(
                            DocumentRevisionPrecondition(
                                uri = resolved.documentUri,
                                contentHash = DocumentModel.hash(file.text),
                                workspaceEpoch = workspaceEpoch,
                            ),
                        )
                    }
                    val plan = EditPlan(
                        planId = WorkspaceModel.createIdentifier("plan_"),
                        adapterId = adapterId,
                        sessionId = sessionId,
                        workspaceId = workspace.workspaceId,
                        expiresAt = Instant.now().plusSeconds(120).toString(),
                        operation = EditOperation.RENAME,
                        // Performed by the IDE's own engine, so the word is accurate (AGENTS.md §4).
                        guarantee = Guarantee.SEMANTIC,
                        atomicity = Atomicity.SEMANTIC,
                        preconditions = preconditions,
                        changes = outcome.prepared.changes,
                        warnings = outcome.prepared.warnings,
                    )
                    plans.register(plan, PreparedEdit.Rename(outcome.prepared), planContext())
                    AdapterRouter.RenameOutcome.Prepared(RefactorPrepareRenameResult(plan))
                }
            }
        }
    }

    override fun locations(
        method: String,
        params: SymbolTargetParams,
    ): SymbolLocationsResult? {
        if (params.workspaceId != workspace.workspaceId) return null
        val handle = params.symbol.handle ?: return SymbolLocationsResult(emptyList(), false)
        val resolved = handles.resolve(handle, handleContext())
            // A handle this adapter did not mint, or that an edit invalidated, is answered as
            // no locations rather than guessed at; the consumer relocates by locator instead.
            ?: return SymbolLocationsResult(emptyList(), false)

        return ReadAction.compute<SymbolLocationsResult, RuntimeException> {
            val element = resolved.anchor.element
                ?: return@compute SymbolLocationsResult(emptyList(), false)
            val found = when (method) {
                "symbol/getDefinition" -> IntelliJNavigation.definition(element)
                "symbol/getReferences" -> IntelliJNavigation.references(project, element)
                else -> IntelliJNavigation.implementations(element)
            }
            SymbolLocationsResult(
                // Every reported URI must sit inside a registered root: the daemon closes the
                // session over one that does not, and a hit in a library is not editable anyway.
                locations = found.locations
                    .filter { location -> withinWorkspace(location.uri) }
                    .map { SymbolLocation(location = it) },
                truncated = found.truncated,
            )
        }
    }

    override fun hierarchy(
        params: SymbolHierarchyParams,
    ): AdapterRouter.HierarchyOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        val empty = AdapterRouter.HierarchyOutcome.Found(SymbolLocationsResult(emptyList(), false))
        val handle = params.symbol.handle ?: return empty
        // A handle this adapter did not mint, or that an edit invalidated, is answered as no
        // neighbours rather than guessed at; the consumer relocates by locator instead.
        val resolved = handles.resolve(handle, handleContext()) ?: return empty

        val relation = when (params.relation) {
            HierarchyRelation.CALLERS -> IntelliJHierarchy.Relation.CALLERS
            HierarchyRelation.CALLEES -> IntelliJHierarchy.Relation.CALLEES
            HierarchyRelation.SUBTYPES -> IntelliJHierarchy.Relation.SUBTYPES
            HierarchyRelation.SUPERTYPES -> IntelliJHierarchy.Relation.SUPERTYPES
        }

        return ReadAction.compute<AdapterRouter.HierarchyOutcome, RuntimeException> {
            val element = resolved.anchor.element ?: return@compute empty
            when (val outcome = IntelliJHierarchy.of(project, element, relation)) {
                IntelliJHierarchy.Outcome.UnsupportedRelation ->
                    AdapterRouter.HierarchyOutcome.Unsupported

                is IntelliJHierarchy.Outcome.Found -> AdapterRouter.HierarchyOutcome.Found(
                    SymbolLocationsResult(
                        // Every reported URI must sit inside a registered root: the daemon closes
                        // the session over one that does not, and a hit in a library is not
                        // editable anyway.
                        locations = outcome.locations
                            .filter { location -> withinWorkspace(location.uri) }
                            .map { SymbolLocation(location = it) },
                        truncated = outcome.truncated,
                    ),
                )
            }
        }
    }

    override fun searchTodos(
        params: WorkspaceSearchTodosParams,
    ): WorkspaceSearchTodosResult? {
        if (params.workspaceId != workspace.workspaceId) return null
        val limit = (params.limit ?: DEFAULT_SEARCH_LIMIT).coerceAtMost(MAX_SEARCH_LIMIT)

        return ReadAction.compute<WorkspaceSearchTodosResult, RuntimeException> {
            // One document when asked for, the whole project otherwise — a sweep is what an agent
            // surveying a codebase wants, and the IDE's own index answers which files carry markers.
            //
            // The two cases are separated rather than chained through an elvis: written that way, a
            // uri the IDE cannot resolve fell through to the project-wide sweep, so asking about one
            // missing file would have answered with every marker in the repository.
            val requested = params.uri
            val found = if (requested == null) {
                IntelliJTodos.inProject(project, limit)
            } else {
                val file = sourceFile(requested)
                    ?: return@compute WorkspaceSearchTodosResult(emptyList(), false)
                IntelliJTodos.inFile(project, file, limit)
            }

            // Every reported URI must sit inside a registered root: the daemon closes the session
            // over one that does not, and a marker in a library is not the consumer's to act on.
            val items = found.items
                .filter { withinWorkspace(it.location.uri) }
                .map { TodoItem(it.location, it.text, it.pattern) }
            WorkspaceSearchTodosResult(items, found.truncated)
        }
    }

    override fun listBookmarks(
        params: WorkspaceListBookmarksParams,
    ): WorkspaceListBookmarksResult? {
        if (params.workspaceId != workspace.workspaceId) return null
        val limit = (params.limit ?: DEFAULT_SEARCH_LIMIT).coerceAtMost(MAX_SEARCH_LIMIT)

        return ReadAction.compute<WorkspaceListBookmarksResult, RuntimeException> {
            val found = IntelliJBookmarks.of(project, limit)
            // Every reported URI must sit inside a registered root: the daemon closes the session
            // over one that does not. A user may well bookmark a library file they are reading.
            val bookmarks = found.items
                .filter { withinWorkspace(it.location.uri) }
                .map { Bookmark(it.location, it.description, it.group) }
            WorkspaceListBookmarksResult(bookmarks, found.truncated)
        }
    }

    override fun resolveAt(params: SymbolResolveAtParams): SymbolResolveAtResult? {
        if (params.workspaceId != workspace.workspaceId) return null
        return ReadAction.compute<SymbolResolveAtResult?, RuntimeException> {
            val file = sourceFile(params.uri) ?: return@compute null
            val text = file.text
            val index = LineIndex(text)
            val offset = index.offsetOf(params.position) ?: return@compute null
            val content = DocumentModel().read(
                workspace,
                params.uri,
                DocumentModel.Source.Buffer(text, isDirty = false),
                languageId = file.language.id.lowercase(),
            )
            if (content !is DocumentModel.Outcome.Ready) return@compute null

            val declaration = IntelliJNavigation.declarationAt(file, offset)
            // No declaration at a position is the canonical answer, not a failure: a consumer
            // asking about whitespace gets a document and no symbol.
            val symbols = if (declaration == null) {
                emptyList()
            } else {
                SymbolMapping.mapDocument(
                    PsiSymbols.declarations(file),
                    params.uri,
                    index,
                ).let { drafts -> handles.materializeTransient(drafts.flatten(), handleContext()) }
                    .filter { it.locator.name == declaration.name }
            }
            SymbolResolveAtResult(content.content.document, symbols.firstOrNull())
        }
    }

    /** Flattens a draft tree so a point resolution can search every declaration, not only roots. */
    private fun List<SymbolHandleRegistry.Draft<PsiAnchor>>.flatten():
        List<SymbolHandleRegistry.Draft<PsiAnchor>> =
        flatMap { listOf(it) + it.children.flatten() }

    /**
     * Whether a URI lies inside a registered root.
     *
     * Public because a deleted document cannot be read to find out: its containment has to be
     * decided from the URI alone, and the daemon closes the session over one it did not authorise.
     */
    public fun withinWorkspace(uri: String): Boolean =
        workspace.roots.any { com.idebridge.jetbrains.workspace.WorkspaceUri.isWithinRoot(uri, it.uri) }

    override fun prepare(params: RefactorPrepareParams): AdapterRouter.RenameOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        if (params.operation == EditOperation.QUICK_FIX) return prepareQuickFix(params)
        if (params.operation !in IntelliJDocumentEdits.SUPPORTED) {
            // Named rather than silently ignored: a consumer must be able to tell an operation
            // this adapter cannot perform from one that performed nothing.
            return AdapterRouter.RenameOutcome.Refused(ErrorCode.CAPABILITY_UNAVAILABLE)
        }
        val uri = params.uri
            ?: return AdapterRouter.RenameOutcome.Refused(ErrorCode.INVALID_REQUEST)

        return ReadAction.compute<AdapterRouter.RenameOutcome, RuntimeException> {
            val file = sourceFile(uri)
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
            val plan = EditPlan(
                planId = WorkspaceModel.createIdentifier("plan_"),
                adapterId = adapterId,
                sessionId = sessionId,
                workspaceId = workspace.workspaceId,
                expiresAt = Instant.now().plusSeconds(120).toString(),
                operation = params.operation,
                guarantee = IntelliJDocumentEdits.guarantee(params.operation),
                atomicity = Atomicity.TEXT_ONLY,
                preconditions = listOf(
                    DocumentRevisionPrecondition(
                        uri = uri,
                        contentHash = DocumentModel.hash(file.text),
                        workspaceEpoch = workspaceEpoch,
                    ),
                ),
                // One document, and the edit count is not knowable before the engine runs, so
                // it is reported as the single rewrite it is rather than an invented total.
                changes = listOf(ChangeSummary(uri = uri, editCount = 1)),
                warnings = emptyList(),
            )
            plans.register(plan, PreparedEdit.Document(params.operation, uri), planContext())
            AdapterRouter.RenameOutcome.Prepared(RefactorPrepareRenameResult(plan))
        }
    }

    /**
     * Prepares a fix the consumer picked from a diagnostic's published offers.
     *
     * The offer is resolved here only to establish it still exists — the action is deliberately not
     * kept. Preparing must not change the file, so nothing is applied; what the plan carries is a
     * summary and a precondition on the document's current content, which is what makes a stale
     * apply fail rather than silently rewrite.
     */
    private fun prepareQuickFix(params: RefactorPrepareParams): AdapterRouter.RenameOutcome {
        val uri = params.uri
            ?: return AdapterRouter.RenameOutcome.Refused(ErrorCode.INVALID_REQUEST)
        val fixId = params.arguments?.get("fixId")?.takeIf { it.isNotBlank() }
            ?: return AdapterRouter.RenameOutcome.Refused(ErrorCode.INVALID_REQUEST)

        return ReadAction.compute<AdapterRouter.RenameOutcome, RuntimeException> {
            val file = sourceFile(uri)
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
            val document = PsiDocumentManager.getInstance(project).getDocument(file)
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
            // An id that no longer names an offer is refused now rather than at apply time, so a
            // consumer learns its choice is stale before it commits to a plan.
            IntelliJDiagnostics.resolveFix(project, document, fixId)
                ?: return@compute AdapterRouter.RenameOutcome.Refused(ErrorCode.PRECONDITION_FAILED)

            val plan = EditPlan(
                planId = WorkspaceModel.createIdentifier("plan_"),
                adapterId = adapterId,
                sessionId = sessionId,
                workspaceId = workspace.workspaceId,
                expiresAt = Instant.now().plusSeconds(120).toString(),
                operation = EditOperation.QUICK_FIX,
                // The IDE's own inspection performs it, so the word is accurate (AGENTS.md §4).
                guarantee = Guarantee.SEMANTIC,
                atomicity = Atomicity.SEMANTIC,
                preconditions = listOf(
                    DocumentRevisionPrecondition(
                        uri = uri,
                        contentHash = DocumentModel.hash(file.text),
                        workspaceEpoch = workspaceEpoch,
                    ),
                ),
                // The engine decides the extent, and inventing a total before it runs would be a
                // claim about an edit nobody has computed.
                changes = listOf(ChangeSummary(uri = uri, editCount = 1)),
                warnings = emptyList(),
            )
            plans.register(plan, PreparedEdit.QuickFix(uri, fixId), planContext())
            AdapterRouter.RenameOutcome.Prepared(RefactorPrepareRenameResult(plan))
        }
    }

    override fun applyPlan(params: WorkspaceApplyPlanParams): AdapterRouter.ApplyOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        return when (val claim = plans.claim(params.planId, planContext())) {
            is RenamePlanRegistry.Claim.Refused -> AdapterRouter.ApplyOutcome.Refused(
                when (claim.reason) {
                    RenamePlanRegistry.Claim.Refusal.EXPIRED -> ErrorCode.PLAN_EXPIRED
                    RenamePlanRegistry.Claim.Refusal.UNKNOWN_PLAN,
                    RenamePlanRegistry.Claim.Refusal.ALREADY_CONSUMED,
                    -> ErrorCode.PLAN_NOT_FOUND

                    else -> ErrorCode.PRECONDITION_FAILED
                },
            )

            is RenamePlanRegistry.Claim.Ready -> {
                val payload = claim.payload
                // Every route in this adapter reads PSI text, and PSI lags an editor buffer until
                // the document is committed. Reading it uncommitted means checking a plan against
                // text the user changed a moment ago and cannot see reflected — which is precisely
                // the state this whole path exists to detect. Found by a test that made an edit and
                // watched the stale plan apply anyway.
                ApplicationManager.getApplication().invokeAndWait {
                    PsiDocumentManager.getInstance(project).commitAllDocuments()
                }
                refreshUnmodifiedFromDisk(claim.plan.preconditions.map { it.uri })

                // Every document the plan names, not just the first.
                //
                // A rename crosses files, and the protocol requires the result to report each one it
                // changed — the daemon refuses a result that omits a planned document, and closes
                // the session over it. Reporting only the declaring file made every cross-file
                // rename fail at apply, after the consumer had already committed to the plan.
                val targets = ReadAction.compute<List<Pair<String, PsiFile?>>, RuntimeException> {
                    claim.plan.changes.map { change -> change.uri to sourceFile(change.uri) }
                }
                val uri = targets.firstOrNull()?.first
                val file = targets.firstOrNull()?.second
                if (uri == null || file == null || targets.any { it.second == null }) {
                    return AdapterRouter.ApplyOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
                }
                val beforeHashes = ReadAction.compute<Map<String, String>, RuntimeException> {
                    targets.associate { (target, psi) ->
                        target to DocumentModel.hash(requireNotNull(psi).text)
                    }
                }

                // The plan's own preconditions, checked before anything is written.
                //
                // `claim` checks session, workspace, epoch and expiry — never the documents. So a
                // plan prepared against text that has since changed was **applied**, writing edits
                // computed for offsets that had moved, and only then did the daemon reject the
                // response for a before-hash that disagreed with the plan. The file was already
                // written by that point: the refusal that exists to prevent the damage arrived
                // after it. Measured against a real IDE on 2026-08-14 (TASK.md §30 step 12).
                val unmet = ReadAction.compute<String?, RuntimeException> {
                    claim.plan.preconditions.firstOrNull { precondition ->
                        val psi = sourceFile(precondition.uri)
                        psi == null || DocumentModel.hash(psi.text) != precondition.contentHash
                    }?.uri
                }
                if (unmet != null) {
                    return AdapterRouter.ApplyOutcome.Refused(ErrorCode.PRECONDITION_FAILED)
                }
                scheduler.runWrite {
                    when (payload) {
                        is PreparedEdit.Rename -> IntelliJRename.apply(payload.prepared)
                        is PreparedEdit.Document ->
                            IntelliJDocumentEdits.apply(payload.operation, file)

                        is PreparedEdit.QuickFix -> {
                            // Re-resolved here, not carried from prepare: between the two phases the
                            // document may have changed, and applying a fix that no longer exists —
                            // or a different one now sharing its position — is the failure this
                            // guards. A missing offer aborts the write rather than substituting.
                            val document = PsiDocumentManager.getInstance(project).getDocument(file)
                            val action = document?.let {
                                IntelliJDiagnostics.resolveFix(project, it, payload.fixId)
                            }
                            if (action == null) {
                                throw IllegalStateException("the chosen fix is no longer offered")
                            }
                            action.invoke(project, null, file)
                        }
                    }
                    // Persist, rather than leaving the change in an unsaved buffer. The VS Code
                    // adapter writes to disk, and the same protocol operation must not mean
                    // "written" on one IDE and "pending in an editor" on another. The change stays
                    // in the IDE's undo stack either way, because it ran as a command.
                    FileDocumentManager.getInstance().saveAllDocuments()
                }

                ReadAction.compute<AdapterRouter.ApplyOutcome, RuntimeException> {
                    val modified = mutableListOf<ModifiedDocument>()
                    for ((target, psi) in targets) {
                        val changed = requireNotNull(psi)
                        val content = DocumentModel().read(
                            workspace,
                            target,
                            DocumentModel.Source.Buffer(changed.text, isDirty = false),
                            languageId = changed.language.id.lowercase(),
                        )
                        if (content !is DocumentModel.Outcome.Ready) {
                            return@compute AdapterRouter.ApplyOutcome.Refused(ErrorCode.INTERNAL_ERROR)
                        }
                        // Handles minted before the edit point at text that has moved.
                        handles.invalidateDocument(workspace.workspaceId, target)
                        tracker.invalidate(target)
                        modified.add(
                            ModifiedDocument(
                                document = content.content.document,
                                beforeHash = requireNotNull(beforeHashes[target]),
                                afterHash = DocumentModel.hash(changed.text),
                            ),
                        )
                        // The daemon holds plans of its own against these documents, and this edit
                        // has just invalidated them.
                        announceChange(content.content)
                    }
                    val token = WorkspaceModel.createIdentifier("undo_")
                    // One uri is enough to undo: the edit ran as a single IDE command, so undoing it
                    // through any of its documents reverts the whole thing.
                    undoable[token] = uri
                    AdapterRouter.ApplyOutcome.Applied(
                        ModificationResult(
                            modifiedDocuments = modified,
                            undoToken = UndoToken(
                                id = token,
                                adapterId = adapterId,
                                sessionId = sessionId,
                                workspaceId = workspace.workspaceId,
                            ),
                        ),
                    )
                }
            }
        }
    }

    override fun undo(params: WorkspaceUndoParams): AdapterRouter.ApplyOutcome? {
        if (params.workspaceId != workspace.workspaceId) return null
        if (params.undoToken.sessionId != sessionId) {
            // A token from another session names an edit this adapter can no longer account for.
            return AdapterRouter.ApplyOutcome.Refused(ErrorCode.INVALID_IDENTIFIER)
        }
        val uri = undoable.remove(params.undoToken.id)
            // One use only: undoing twice would revert an edit the consumer never made.
            ?: return AdapterRouter.ApplyOutcome.Refused(ErrorCode.PRECONDITION_FAILED)

        val virtualFile = VirtualFileManager.getInstance().findFileByUrl(uri)
            ?: return AdapterRouter.ApplyOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)
        val before = ReadAction.compute<String?, RuntimeException> {
            sourceFile(uri)?.let { DocumentModel.hash(it.text) }
        } ?: return AdapterRouter.ApplyOutcome.Refused(ErrorCode.DOCUMENT_NOT_FOUND)

        // On the dispatch thread but **not** inside a write command: UndoManager opens its own,
        // and nesting one inside ours is rejected by the platform.
        var outcome: IntelliJUndo.Outcome = IntelliJUndo.Outcome.Refused
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
            // `IntelliJUndo` leaves the platform consistent for us: it commits PSI and saves, so
            // the read below sees the reverted text rather than the pre-undo text.
            outcome = runCatching { IntelliJUndo.undo(project, virtualFile) }
                .getOrDefault(IntelliJUndo.Outcome.Refused)
        }
        // Named in the log: four hypotheses about this failure were wrong, and the IDE's own
        // answer is the only thing that settles which refusal actually happened.
        com.intellij.openapi.diagnostic.logger<AdapterBackend>()
            .info("[IDE Bridge] undo outcome for " + uri + ": " + outcome)
        if (outcome != IntelliJUndo.Outcome.Reverted) {
            return AdapterRouter.ApplyOutcome.Refused(ErrorCode.PRECONDITION_FAILED)
        }

        return ReadAction.compute<AdapterRouter.ApplyOutcome, RuntimeException> {
            val file = sourceFile(uri)
                ?: return@compute AdapterRouter.ApplyOutcome.Refused(ErrorCode.INTERNAL_ERROR)
            val content = DocumentModel().read(
                workspace,
                uri,
                DocumentModel.Source.Buffer(file.text, isDirty = isDirty(file)),
                languageId = file.language.id.lowercase(),
            )
            if (content !is DocumentModel.Outcome.Ready) {
                return@compute AdapterRouter.ApplyOutcome.Refused(ErrorCode.INTERNAL_ERROR)
            }
            handles.invalidateDocument(workspace.workspaceId, uri)
            tracker.invalidate(uri)
            // An undo moves the document as surely as the edit it reverses did.
            announceChange(content.content)
            AdapterRouter.ApplyOutcome.Applied(
                ModificationResult(
                    modifiedDocuments = listOf(
                        ModifiedDocument(
                            document = content.content.document,
                            beforeHash = before,
                            afterHash = DocumentModel.hash(file.text),
                        ),
                    ),
                ),
            )
        }
    }

    override fun discardPlan(params: WorkspaceDiscardPlanParams): WorkspaceDiscardPlanResult? {
        if (params.workspaceId != workspace.workspaceId) return null
        val refusal = plans.discard(params.planId, planContext())
        return WorkspaceDiscardPlanResult(params.planId, discarded = refusal == null)
    }
}
