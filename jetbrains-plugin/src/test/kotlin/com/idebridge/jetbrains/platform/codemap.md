# test/…/platform/

## Responsibility

Tests for the IntelliJ side: what the IDE's own engines report, and what this adapter is allowed to
claim about it. The largest test package here, because this is where the adapter can most easily
lie.

## Design

**Surface tests pin what the platform offers**, so a capability is advertised only if it exists.
`RefactoringFactorySurfaceTest`, `SafeDeleteSurfaceTest`, `StructuralRefactoringSurfaceTest` and
`FileTypeSurfaceTest` each fail if a future IDE version changes what is available, which is the point:
the decision is re-made rather than silently inherited.

**Real-project fixtures, not mocks of the IDE.** These run on `BasePlatformTestCase` with real files,
because the defects worth catching are in what IntelliJ actually answers — inherited members
attributed to the wrong class, a quick-fix title arriving as HTML, a `.ts` file opened by TextMate
and looking supported.

**One project per class is reused**, so a test that leaves state behind leaks into the next.
Bookmarks live on the project and have done exactly that.

## Flow

```
StructureViewSymbolsTest, InheritedMembersTest, OtherLanguageSymbolsTest, LanguageUnsupportedTest
     what counts as a declaration, and what "this IDE cannot describe this file" means
PlatformSymbolKindMapperTest, SymbolKindSourceTest, DeclarationTypeTest
     kinds come from the platform's own description, never from a guess
IntelliJSymbolSearchTest, SymbolSearchKindFilterTest, NavigationTest, IntelliJHierarchyTest
     search, filtering during collection, navigation and hierarchy
IntelliJDiagnosticsTest, QuickFixTitleTest, ResolveFixTest, DaemonAnalysisTrackerTest
     inspections, their offered fixes, and when analysis is actually complete
IntelliJRenameTest, DocumentEditsTest, IntelliJUndoTest
     the edits, and reverting them
IntelliJTodosTest, IntelliJBookmarksTest, IntelliJProjectSnapshotTest
     the smaller surfaces, and what a project publishes
RealDaemonSymbolsTest
     records packages/conformance/captures/jetbrains.json
```

## Integration

`RealDaemonSymbolsTest` is what keeps the conformance capture current; the judgement in
`packages/conformance` is only as fresh as the last run of this file.
