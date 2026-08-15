# ADR-0028: Structural refactorings are refused, not approximated

- Status: accepted
- Date: 2026-08-09
- Related: [ADR-0024](0024-kotlin-protocol-types.md), [ADR-0027](0027-jetbrains-diagnostics-require-internal-api.md)

## Context

The edit-plan vocabulary carries eight operations. Four have behaviour behind them — `rename`,
`reformat`, `optimizeImports`, `quickFix` — and four have never had any: `extractMethod`, `inline`,
`move`, `changeSignature`.

The adapter's governing rule is that it ships no language-specific code and performs everything
through the host IDE's own engines. For the four implemented operations that works, because each has
a language-neutral service behind it — `CodeStyleManager`, `OptimizeImportsProcessor`, the rename
engine, `IntentionAction`.

The question for the remaining four is whether such a service exists.

## Measurement

`StructuralRefactoringSurfaceTest` asks the platform directly, against a real Java project:

- `LanguageRefactoringSupport.forContext(file)` returns a provider, so a generic caller can reach a
  language's refactorings at all.
- `provider.extractMethodHandler` returns a **non-null** `RefactoringActionHandler`.

`RefactoringActionHandler`'s only entry points are `invoke(Project, Editor, PsiFile, DataContext)`
and `invoke(Project, Array<PsiElement>, DataContext)`. Both are documented to drive the refactoring's
user interface — they show a dialog, collect the user's choices, and perform the edit. Neither
computes a result and returns it.

The assertion is deliberately not guarded by a null check. A design decision rests on it, and
`if (handler != null) { … }` would have passed while proving nothing — the vacuous shape this project
has already caught twice.

## Decision

**`extractMethod`, `inline`, `move` and `changeSignature` are refused by name.** They remain in the
protocol vocabulary, so a consumer can ask and receive `CAPABILITY_UNAVAILABLE` rather than an
unexplained absence, and the adapter performs none of them.

Three alternatives were considered and rejected.

**Driving the UI handler headlessly.** The adapter answers on a socket thread. A modal dialog does
not merely look wrong in that context — it blocks the request until the route times out, which is
the exact failure this project spent a day diagnosing on `refactor/prepare`. A refactoring that hangs
the connection is worse than one that is absent.

**Using a language's own processor.** `ExtractMethodProcessor` performs a Java extract-method without
a dialog, and equivalents exist per language. Taking that route means naming languages in the
adapter — the rule a deleted Java classifier already cost seven Plugin Verifier problems to enforce.
It would also work in exactly the IDEs we happened to write code for and silently do nothing
elsewhere, which is the opposite of what this adapter promises.

**Implementing the edit ourselves.** Extracting a method textually is not extracting a method. It
would be a textual edit described as a semantic one, which AGENTS.md §4 forbids in those words.

## Consequences

The vocabulary is wider than the behaviour, and `docs/STATUS.md` says so plainly rather than listing
eight operations as though they were equivalent.

This is a fact about the platform's public surface, not a gap to be closed by more effort here. It
would change if JetBrains published a headless refactoring API — the probe test is written so that a
future platform returning something other than a UI handler fails it, which turns this ADR back into
an open question rather than letting it quietly become false.

## Addendum, 2026-08-09: the second entry point

The measurement above looked only at `LanguageRefactoringSupport`, and the conclusion was written as
though that were the platform's whole refactoring surface. It is not. A headless API does exist, and
this adapter was already using it: `IntelliJRename` performs renames through
`RefactoringFactory.createRename`, with no editor and no dialog.

`RefactoringFactorySurfaceTest` enumerates that factory by reflection rather than by reading
documentation. It offers five methods: three `createRename` overloads, `createSafeDelete`, and
`getInstance`.

That leaves this ADR's decision intact — the factory offers nothing for `extractMethod`, `inline`,
`move` or `changeSignature`, so for those four the dialog-driven handler really is the only route —
but it corrects the reasoning. The claim was never "the platform exposes no headless refactoring";
it is "the platform exposes headless refactoring for rename and safe delete, and for nothing else".

Safe delete is therefore available and is **not** offered, for a different reason: `TASK.md` §29
lists it as explicitly outside the MVP, next to the four above. `SafeDeleteSurfaceTest` records what
the platform can do — `findUsages()` reports the call sites that would break, separately from
`run()`, without deleting anything — so that if the scope decision is ever revisited it is revisited
against a measurement. Until then no protocol method exposes it. The distinction matters: these four
are refused because the IDE cannot do them headlessly, while safe delete is absent because the
product said not yet.
