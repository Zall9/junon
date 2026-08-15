# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/platform/

## Responsibility

The only place in the JetBrains adapter that reads live IntelliJ state. Captures content roots, trust, and index readiness from a `Project` and hands them to the pure-Kotlin mappers in `workspace/` as `WorkspaceModel.ProjectSnapshot` and `ReadinessModel.IndexState`. No IntelliJ object crosses the wire (AGENTS.md §3). One file: `IntelliJProjectSnapshot`. Everything above it is testable without the platform because of this thin boundary.

## Design Patterns

- **Anti-corruption layer (the sole IntelliJ reader)** — Everything above this file works on `WorkspaceModel.ProjectSnapshot` and `ReadinessModel.IndexState`, so mapping rules are tested without the platform and this layer stays small enough to review by eye (`IntelliJProjectSnapshot.kt:14-17`).
- **Read-action guard** — Content roots are read inside `ReadAction.compute<List<String>, RuntimeException>` because the project model may be mutated from another thread; reading it without a read action is a race the platform explicitly forbids (`IntelliJProjectSnapshot.kt:18-20, 29-36`).
- **URI passthrough, no path conversion** — Content-root `url` is already a VFS URI; passed through unchanged rather than converted to a local path, which the protocol forbids (AGENTS.md §2) (`IntelliJProjectSnapshot.kt:33-35`).
- **Public-API-only trust reading** — Uses `TrustedProjects.isProjectTrusted` (boolean) rather than the internal `getProjectTrustedState` overloads marked `@ApiStatus.Internal`. This costs the `UNDECIDED` distinction but avoids depending on API the platform reserves the right to remove (`IntelliJProjectSnapshot.kt:46-60`).

## Key Types

### `IntelliJProjectSnapshot` (object, `IntelliJProjectSnapshot.kt:21-75`)
Stateless façade over IntelliJ project state.
- `Snapshot` (private data, `:70-74`) — implements `WorkspaceModel.ProjectSnapshot` with `name`, `rootUris`, `trust`. Never exposed; returned as the interface.

## Key Functions

- `capture(project: Project): WorkspaceModel.ProjectSnapshot` (`IntelliJProjectSnapshot.kt:28-42`) — Reads content roots in a `ReadAction`, maps to VFS URIs, `.distinct()`. Returns `Snapshot(name, rootUris, trust)`. Must not be called on the EDT with a project that is still opening; callers schedule it off the dispatch thread (AGENTS.md §3).
- `trustState(project: Project): WorkspaceModel.TrustState` (`:55-60`) — `TrustedProjects.isProjectTrusted` → `GRANTED`/`DENIED`. `UNDECIDED` is lost here (public API limitation). Loss of fidelity, not safety — the daemon permits writes only on `trusted`, so an undecided project is refused either way.
- `indexState(project: Project): ReadinessModel.IndexState` (`:63-68`) — `!project.isInitialized` → `INITIALIZING`; `DumbService.isDumb` → `DUMB`; else `SMART`. Dumb mode is what makes `indexing` and `INDEX_NOT_READY` truthful on this adapter.

## Data & Control Flow

```
Project (live IntelliJ)
   │
   ├─ capture(project)
   │    ├─ ReadAction.compute { ProjectRootManager.contentRoots.map { it.url }.distinct() }
   │    ├─ trustState(project)  ──► TrustedProjects.isProjectTrusted  ──► GRANTED | DENIED
   │    └─ Snapshot(name, rootUris, trust)  ──►  WorkspaceModel.ProjectSnapshot
   │
   └─ indexState(project)
        ├─ !project.isInitialized  ──► INITIALIZING
        ├─ DumbService.isDumb       ──► DUMB
        └─ else                     ──► SMART                       ──►  ReadinessModel.IndexState
```

Output (the two interface values) flows into `WorkspaceModel.snapshot()` and `ReadinessModel.status()` in `workspace/`, which produce the protocol DTOs. No `Project`, `VirtualFile`, or PSI object leaves this layer.

## Integration Points

- **Consumed by:**
  - The plugin's lifecycle / project-open handler calls `capture()` and `indexState()` to build the `Workspace` and `WorkspaceStatus` for registration and status events.
  - Tests in `src/test/kotlin/.../platform/IntelliJProjectSnapshotTest` exercise `capture`, `trustState`, and `indexState` (imports from `workspace/`).
- **Depends on:**
  - `com.idebridge.jetbrains.workspace.ReadinessModel` — `IndexState` (`IntelliJProjectSnapshot.kt:3`).
  - `com.idebridge.jetbrains.workspace.WorkspaceModel` — `ProjectSnapshot`, `TrustState` (`:4`).
  - IntelliJ Platform: `com.intellij.ide.trustedProjects.TrustedProjects`, `com.intellij.openapi.application.ReadAction`, `com.intellij.openapi.project.DumbService`, `com.intellij.openapi.project.Project`, `com.intellij.openapi.roots.ProjectRootManager` (`:5-9`).
- **External boundaries:**
  - Content roots via `ProjectRootManager.getInstance(project).contentRoots` (`:30-31`).
  - Trust via `TrustedProjects.isProjectTrusted(project)` (public API) (`:56`).
  - Index state via `DumbService.isDumb(project)` and `project.isInitialized` (`:65-67`).
  - Threading: read action required for content roots; callers must not invoke `capture()` on the EDT during project open.

## Common Gotchas

- **No IntelliJ object crosses the wire.** This layer maps `Project` → `ProjectSnapshot` (interface) and `Project` → `IndexState` (enum). Anything PSI- or VFS-typed must be resolved here, not leaked upward (AGENTS.md §3, `IntelliJProjectSnapshot.kt:16`).
- **`UNDECIDED` trust is lost on this adapter.** The only public trust reader is boolean `TrustedProjects.isProjectTrusted`; the three-state `getProjectTrustedState` overloads are `@ApiStatus.Internal`. An undecided project reports as `DENIED` here. The protocol still carries `unknown` because it is the honest answer for an adapter that can observe it (`IntelliJProjectSnapshot.kt:46-60`). This is a loss of fidelity, not safety.
- **Content roots require a read action.** `ReadAction.compute` is mandatory — the project model may be mutated from another thread, and reading it without one is a race the platform forbids (`IntelliJProjectSnapshot.kt:18-20, 29-36`).
- **Do not call `capture()` on the EDT during project open.** Callers must schedule it off the dispatch thread (AGENTS.md §3, `IntelliJProjectSnapshot.kt:25-27`).
- **Content-root `url` is a VFS URI, passed through.** It is not converted to a local path; the protocol forbids the conversion (AGENTS.md §2, `IntelliJProjectSnapshot.kt:33-35`).
- **`.distinct()` on content roots.** Duplicate roots are collapsed before they reach `WorkspaceModel`, which would otherwise reject duplicates (`WorkspaceModel.kt:59`).
- **This was written when `IntelliJProjectSnapshot` was the only IntelliJ-touching file here. It is no longer.** The package now holds fourteen: `DaemonAnalysisTracker`, `IntelliJBookmarks`, `IntelliJDiagnostics`, `IntelliJDocumentEdits`, `IntelliJEditScheduler`, `IntelliJHierarchy`, `IntelliJNavigation`, `IntelliJProjectSnapshot`, `IntelliJRename`, `IntelliJSymbolSearch`, `IntelliJTodos`, `IntelliJUndo`, `PsiSymbols`, `StructureViewSymbols`.
- **The boundary rule still holds, and is what matters.** `workspace/`, `symbol/`, `document/` and `edit/` stay pure Kotlin; every platform touch lives in this package and converts to protocol types before anything above sees it, so the mapping rules remain testable without the platform. What changed is the number of doors, not where the wall is.
- **`IntelliJDiagnostics` is the only file using internal API**, and its two symbols are baselined with a reason (ADR-0027). Every other file here is public-API only, which the Plugin Verifier checks against `internal-api-baseline.txt` on four IDEs.

---

## Platform Layer Files (Phase 4)

The package now holds fourteen files. `IntelliJProjectSnapshot` is documented above; the remaining thirteen are grouped by concern. Each is a `public object` (or `class` for `DaemonAnalysisTracker` and `IntelliJEditScheduler`) that reads live IntelliJ state and converts it to protocol types before anything above sees it. The anti-corruption boundary rule still holds: `workspace/`, `symbol/`, `document/`, `edit/`, and `diagnostic/` stay pure Kotlin; every platform touch lives in this package.

### Diagnostics & Analysis State

- `IntelliJDiagnostics` (`IntelliJDiagnostics.kt:27`, object) — Reads the IDE's current highlights for a document. **The only file using internal platform API** (`DaemonCodeAnalyzerImpl.getHighlights`, `HighlightInfo` — `@ApiStatus.Internal`, ADR-0027). Converts `HighlightInfo` to `DiagnosticMapping.Highlight` immediately, so a platform change touches this file and nothing above it. Filters at `HighlightSeverity.WEAK_WARNING` (line 34) — below that is syntax colouring, not problems. `fixesOf(info)` (`:57-81`) extracts quick-fix offers via the public `findRegisteredQuickFix`, digesting `familyName + title` into a stable id. `resolveFix(project, document, fixId)` (`:95-110`) **re-derives** the fix from current highlights rather than looking it up in a registry — if the document changed, the digest no longer matches and the request is refused (fails closed for free). Callers must hold a read action.
- `DaemonAnalysisTracker` (`DaemonAnalysisTracker.kt:22`, class, `Disposable`) — Records which documents the IDE has finished analysing. Needed because `getHighlights` answers with what the daemon has **already** computed: a never-analysed document comes back empty, and empty is indistinguishable from clean. Uses only public API (`DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC`). `daemonFinished` adds URIs to the analysed set; `daemonCancelEventOccurred` clears it (a cancelled run is not a finished analysis). `state(file, document)` (`:51-67`) returns `COMPLETED` / `PENDING` / `UNAVAILABLE`. `invalidate(uri)` (`:47-49`) forgets a document so an edit makes the next answer incomplete until the daemon catches up. Callers: `AdapterBackend` constructs one per project and passes it to `DiagnosticMapping.map` and `IntelliJDiagnostics`.

### Symbol Discovery & Classification

- `PsiSymbols` (`PsiSymbols.kt:33`, object) — Describes any file's declarations in any JetBrains IDE. `PsiNameIdentifierOwner` is implemented by every language's PSI, so a declaration's name, identifier, and extent come from the host IDE's own parser. `declarations(file)` (`:43-48`) prefers the IDE's own structure model (`StructureViewSymbols.declarations`) and falls back to `childDeclarations` for languages that ship no structure view. `namedDescendants(parent)` (`:61-75`) walks to the nearest **named** element rather than a fixed depth — a method inside a class body sits one level down regardless of intermediate unnamed nodes. The boundary is the language's `name`, not its `nameIdentifier`: keying it on the identifier stepped over a declaration the language does name and hoisted its members into the container (ADR-0030). `identifierRange(element, declaration)` (`:118-128`, internal) is the one rule both symbol paths read for what a rename would replace — the spelled identifier, or an **empty range at `textOffset`** where the language spells none, guarded to lie inside the declaration. Type alias `PsiAnchor = SmartPsiElementPointer<out PsiElement>` (`:15`) — what the platform can resolve back to in O(1) across PSI rebuilds. Callers must hold a read action.
- `StructureViewSymbols` (`StructureViewSymbols.kt:46`, object) — Reads declarations from the IDE's own structure model (the "Structure" tool window tree). `declarations(file)` (`:55-67`) returns `null` when the IDE has no structure model for the language (distinct from an empty list — `null` means "cannot describe", empty means "can, and there is nothing"). Uses `LanguageStructureViewBuilder` and builds the model headlessly (null editor). Kind is the part the platform does not publish (`TreeElement` offers text and icon, not a typed classification), so it comes from `SymbolKindMapper` or is `UNKNOWN`. **A row this adapter cannot describe is transparent, not opaque**: `declarations(element, file, within)` (`:81-114`, internal for test access) reads the rows inside it in its place, because a row's own unnameability says nothing about its members — until 2026-08-09 it discarded the subtree, which lost everything inside a Kotlin `companion object` (ADR-0030). Names come from the language; a row's presentation text is a rendering and is never used as one. Elements from another file (inherited members shown for context) are the one opaque case — dropped with their subtree, since none of those offsets address this text. A new `within: TextRange? = null` parameter (`:84`) on the internal `declarations()` adds a containment guard (`:103-106`): `if (value != null && within != null) { if (!within.contains(value.textRange)) return emptyList() }` — a declaration reported inside a parent must textually lie inside it. Catches same-file inherited members: measured against a real PyCharm, `IdeStatusTool` declared only `apply` yet the model offered `_client`, `_workspace_id` and `_explain` beneath it, carrying the ranges of `IdeBridgeTool` — one class's members reported as another's, and the same declarations twice in one document. Visibility changed from `private` to `internal` (`:81`) for test access. Children receive the parent's `declaration` range as `within` (`:141`); transparent rows pass `within` through unchanged (`:112`).

### Navigation

- `IntelliJNavigation` (`IntelliJNavigation.kt:26`, object) — Navigation answered by the IDE's own search engines. `definition(element)` (`:37-38`) — the element's own location. `references(project, element)` (`:46-54`) — `ReferencesSearch.search` in `projectScope`, capped at `MAX_RESULTS = 1_000` (line 32). `implementations(element)` (`:57-64`) — `DefinitionsScopedSearch.search`. `declarationAt(file, offset)` (`:73-79`) — the nearest `PsiNameIdentifierOwner` containing the offset, via `PsiTreeUtil.findElementOfClassAtOffset`. `locationOf(element, range)` (`:100-116`, private) converts a PSI element to a `Location` DTO; returns `null` for anything without a file or text range (library stub, synthetic element). `locationOfDeclaration` (`:91`) is exposed for `IntelliJHierarchy` to reuse — the rules about what cannot be located must hold identically for both. Callers must hold a read action.

### Hierarchy

- `IntelliJHierarchy` (`IntelliJHierarchy.kt:27`, object) — One step of a call or type hierarchy, answered by the IDE's own resolution. Walked one level at a time (bounds a response without a depth parameter). `Relation` enum (`:42`): `CALLERS`, `CALLEES`, `SUBTYPES`, `SUPERTYPES`. `of(project, element, relation)` (`:44-50`) dispatches: callers via `ReferencesSearch` (returns enclosing declarations, not call sites — `:59-69`), callees via resolving references inside the element's subtree (drops self-references — `:79-93`), subtypes via `DefinitionsScopedSearch`, supertypes → `UnsupportedRelation` (no language-neutral engine — stated, not approximated). `Outcome` sealed interface (`:29-40`): `Found(locations, truncated)` | `UnsupportedRelation`. Shares `MAX_RESULTS` with `IntelliJNavigation` (line 63, 83, 99, 118). Callers must hold a read action.

### Edits & Refactoring

- `IntelliJEditScheduler` (`IntelliJEditScheduler.kt:19`, class) — Implements `EditScheduler`. Runs an edit on the dispatch thread inside a `WriteCommandAction` via `invokeAndWait` (blocks until done — returning earlier would report a modification the consumer cannot yet observe). The command wrapper puts the change in the IDE's own undo stack, so a user can undo an agent's refactoring as they would their own — which is also what makes `workspace/undo` meaningful. A failure inside the write action is rethrown on the calling thread (line 35), so the router answers with a refusal instead of a success carrying nothing.
- `IntelliJDocumentEdits` (`IntelliJDocumentEdits.kt:19`, object) — Document-scoped edits performed by the IDE's own engines. `SUPPORTED = {REFORMAT, OPTIMIZE_IMPORTS}` (line 22-23). `apply(operation, file)` (`:32-40`) runs `CodeStyleManager.reformat` or `OptimizeImportsProcessor` — must be called inside a write action on the EDT. `guarantee(operation)` (`:49-53`): `REFORMAT` → `SYNTACTIC` (rewrites layout, never meaning), `OPTIMIZE_IMPORTS` → `SEMANTIC` (changes what the file references). Neither operation takes a target beyond the document.
- `IntelliJRename` (`IntelliJRename.kt:25`, object) — Renames through the IDE's own refactoring engine. Two phases: `prepare` (`:48-108`) asks the engine which usages it would change and reports them as `ChangeSummary` per file; `apply` (`:117-119`) runs the engine. The plan is a summary, not a diff — applying the real refactoring rather than replaying text edits keeps the `semantic` guarantee accurate (the engine updates imports, overriding methods, qualified references). `MAX_USAGES = 5_000` (line 31) — a rename touching more is refused. `Outcome` sealed interface (`:40-46`): `Ready(prepared)` | `Refused(NOT_RENAMABLE | TOO_MANY_USAGES | NO_USAGES)`. Renamability is checked explicitly (the engine accepts non-renamable elements and simply finds no usages). Comment/string occurrences are excluded (`isSearchInComments = false`) — including textual matches would make the `semantic` guarantee untrue. The declaration's own file is counted separately (line 75) — `findUsages` returns references only, so without this the plan would understate which documents change. Callers: `prepare` only reads; `apply` must be on the EDT.

### Search & Discovery

- `IntelliJSymbolSearch` (`IntelliJSymbolSearch.kt:18`, object) — Workspace-wide symbol search backed by the IDE's own "Go to Symbol" index (`ChooseByNameContributor`). `MAX_RESOLVED_NAMES = 20_000` — bounds calls to `getItemsByName`, the half that reads the index and builds PSI; reading and matching names is not counted. Counting names *seen* was measured in a real IDE (2026-08-10) to spend the whole budget on JDK and Kotlin library names before reaching the project's own, so every query answered with nothing while flagging `truncated` — and one large contributor starved all the others (ADR-0032). Substring matching (not the IDE's fuzzy matching — fuzzy ranking is a presentation decision for a human; a consumer means the name). Non-project items excluded. `Found(elements, truncated)` (line 40). `search(project, query, limit, kinds)` (`:61`) — the `kinds: Set<SymbolKind>? = null` parameter (`:65`) filters declarations inline during collection (`:92`): `if (kinds != null && SymbolKindMapper.classify(declaration) !in kinds) continue` — applied while collecting, not after, so rejected kinds do not spend the caller's limit. Filtering a completed page would answer "three classes" for a project holding twenty and mark it complete. The filter was measured missing on 2026-08-11: a real PhpStorm asked for `class` returned methods; the protocol has always declared the parameter and the VS Code adapter has always honoured it, so the two adapters answered differently. `named(item)` (`:116`, private) keeps an item the **language names**, in a file; keying it on `nameIdentifier` dropped a Kotlin companion object from every result while reporting `truncated = false` — the index does offer the name `Companion` (ADR-0030). Callers must hold a read action.

### Bookmarks, TODOs, Undo

- `IntelliJBookmarks` (`IntelliJBookmarks.kt:24`, object) — The user's own bookmarks, as the IDE holds them. Only line bookmarks are reported (`LineBookmark`); file and tree-node bookmarks have no position an agent could act on. A bookmark marks a line, not a span — the range is the line's start. Group/description from the first group (a bookmark can sit in several groups with different descriptions — concatenating would invent a sentence). `Found(items, truncated)` (line 28). Callers must hold a read action.
- `IntelliJTodos` (`IntelliJTodos.kt:20`, object) — The IDE's own TODO markers via `PsiTodoSearchHelper`. Patterns are the ones configured in the IDE's settings (`TODO`, `FIXME`, custom). `inFile(project, file, limit)` (`:34-62`) — text from the marker's own range, not the whole comment. `inProject(project, limit)` (`:71-97`) — uses `processFilesWithTodoItems` (the IDE's own index answering which files carry markers) with an `EmptyProgressIndicator` (required by the platform; the adapter runs headless). `MAX_TEXT = 500` (line 100, matches protocol ceiling). Callers must hold a read action.
- `IntelliJUndo` (`IntelliJUndo.kt:21`, object) — Undo driven through the IDE's own stack. Every edit this adapter applies runs inside a `WriteCommandAction`, so it is already in the undo history — reverting through that stack keeps one history rather than a parallel one. **The editor is passed explicitly, never inferred from focus** — relying on focus would let an agent's undo revert a document its plan never named. `undo(project, file)` (`:39-61`) opens an editor if needed, calls `UndoManager.undo(editor)`, commits PSI (`commitAllDocuments` — reading `PsiFile.text` before this gets pre-undo text), and saves. `Outcome` sealed (`:23-31`): `Reverted` | `NothingToUndo` | `Refused`. Must run on the dispatch thread.
