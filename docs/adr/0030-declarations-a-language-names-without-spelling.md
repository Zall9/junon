# ADR-0030 — Declarations a language names without spelling

## Status

Accepted — 2026-08-09

## Context

`document/getSymbols` on the JetBrains adapter reads the IDE's own structure model
(`StructureViewSymbols`), because that tree is the language plugin's answer to what a file contains
(ADR-0016 for the route, ADR-0003 and ADR-0018 for the locator and its relocation). The protocol
requires a `selectionRange` per symbol, defined in ADR-0003 as the range of the symbol's identifier
rather than of the whole declaration. The IntelliJ Platform publishes no `selectionRange` equivalent,
so the adapter derived it from `PsiNameIdentifierOwner.nameIdentifier` and skipped any declaration
that had none — an anonymous class, an initializer block — on the stated grounds that no locator can
address what has no name.

That rule silently over-reached, and the measurement is unambiguous. Measured 2026-08-09 in a
`BasePlatformTestCase` fixture against Kotlin's K2 structure model
(`KotlinFirStructureViewFactory`), for:

```kotlin
class Service {
    companion object {
        fun run() {}
    }
}
```

the structure model contains the row and its member:

```
KtClass              name=Service    nameIdentifier=Service
  KtObjectDeclaration name=Companion  nameIdentifier=null   textRange=(20,65) textOffset=30
    KtNamedFunction    name=run       nameIdentifier=run     textRange=(47,59)
```

while `PsiSymbols.declarations` mapped through `SymbolMapping.mapDocument` yielded exactly
`[(Service, CLASS)]`. The IDE was not withholding anything: the language names the declaration
`Companion` and merely spells no identifier for it, and the adapter discarded the row **and its
subtree**, because children were built inside the same function that refused the parent. Kotlin
companion objects routinely hold factory functions and constants, so a consumer received an empty
answer presented as a complete one, with no refusal to explain it. The same loss applied to every row
the model contains that the adapter cannot address: Kotlin's model does list anonymous object
declarations, whose overridden members went with them.

Two further facts came out of the same measurement:

- The declaration's own range is **not** a usable stand-in for the identifier. With an annotation or
  modifiers present the declaration starts at `@Deprecated`, offset 20, while the platform's own
  caret target for the declaration is offset 59 — the `object` keyword.
- The existing fallback for a missing name, the structure row's presentation text, is not a name at
  all. It is a rendering for a human (Java presents a field as `r: Runnable = new Runnable() {...}`,
  Kotlin an initializer as `<class initializer>`), and computing it for a Kotlin anonymous object
  required the Analysis API, which threw `ProhibitedAnalysisException` when `document/getSymbols` was
  called from a thread where analysis is prohibited.

## Decision

### A name makes a declaration reportable; spelling refines it

- A declaration is reported when the language gives it a **name**. Whether the text also spells that
  name out is a separate question, answered by the selection range below.
- The name is the language's own (`PsiNamedElement.name`). A row's presentation text is never used as
  a name: it is a rendering, and reporting it would invent a name rather than carry one. The
  presentation fallback is removed.
- A declaration the language does not name at all remains unreported. No locator can address it.

### The selection range says what the text says

- When the language spells an identifier, the selection range is that identifier's range, unchanged.
- When it does not, the selection range is **empty, at the offset the platform navigates the caret
  to** (`PsiElement.textOffset`). That locates the declaration without claiming any text is its name.
  It is the platform's own answer, not a synthesized one, and it is measurably better placed than the
  declaration's start, which sits before annotations and modifiers.
- The anchor is required to lie inside the declaration, as the protocol requires of every selection
  range. A declaration whose anchor falls outside it is treated as undescribable rather than allowed
  to fail the whole document's mapping.
- Rename continues to refuse an element with no identifier (`NOT_RENAMABLE`, `IntelliJRename`). The
  empty range and the refusal state the same fact, and a consumer learns it by being refused.

### A row that cannot be described is transparent, not opaque

- A structure row the adapter cannot report contributes the declarations of the rows inside it. Its
  own unnameability is a statement about itself, never about its members.
- The single exception is a row belonging to another file — an inherited member shown for context.
  That statement *is* about the whole subtree, since none of those offsets address this document.
- The structure-model path and the PSI walk it falls back to now follow one rule
  (`PsiSymbols.identifierRange`), rather than each answering the question its own way.

### Both symbol routes read that rule

`workspace/searchSymbols` applied the identifier requirement twice — in the index reader
(`IntelliJSymbolSearch.named`) and again in its own mapping (`AdapterBackend.searchSymbols`).
Measured 2026-08-09: the IDE's own "Go to Symbol" index **does** offer the name `Companion`
(`KotlinGotoClassContributor`, item `KtObjectDeclaration`, `nameIdentifier = null`), and a search for
it returned an empty list with `truncated = false` — the route omitted the hit *and* called the answer
complete.

ADR-0017 permits dropping an in-scope hit IDEBP cannot represent, but requires saying so through
`truncated`. Under this ADR such a declaration **is** representable, so it is reported rather than
counted as a loss, and `truncated` keeps its meaning: a real ceiling was reached.

Both gates now read `PsiSymbols.identifierRange`. Each was independently blocking, confirmed by
separate mutation: with only the index reader corrected, the mapping still refused the hit.

## Consequences

- A companion object's members are reported, nested under the companion, with real identifier ranges
  of their own. The companion is reported with `kind: unknown`, unchanged: Kotlin calls it a
  "companion object", naming two vocabulary words at once, and `PlatformSymbolKindMapper` refuses
  compound phrases.
- The property "the text at `selectionRange` equals the symbol's name" holds only for declarations a
  language spells. It was never universal — ADR-0017 already allows a selection range as coarse as
  the only range the platform supplies — and the cross-language expected contracts in
  `packages/protocol/fixtures/languages/` contain spelled declarations only.
- A member of an unnamed declaration is attributed to the nearest container that *can* be addressed:
  the `run` of `val task = object : Runnable { … }` is reported under `task`. The intermediate
  container is lost, which is unavoidable — it has no name to report — and the alternative was losing
  the member.
- Structure models differ by language and the adapter reports what each gives. Measured: Java's model
  does not list anonymous classes at all, so a method declared inside one is absent for Java and
  present for Kotlin. That asymmetry is the IDE's own and is not corrected here.
- The two symbol routes can no longer contradict each other. Before this, `document/getSymbols`
  reported `Service.Companion` while `workspace/searchSymbols` answered a search for that same name
  with nothing, and said the result was complete.
- Confirmed in a real IDE on the plugin's own source: a search for `Companion` returns **15 real
  `companion object` declarations** — `AdapterBackend`, `WorkspaceModel`, `RpcClient`,
  `SymbolHandleRegistry` and the rest — each with `kind: unknown` and an empty selection range, none of
  which appeared in a search result before. The sixteenth hit in that result is the control: a
  `companion` **property** in a test fixture, whose name the text does spell, carries a real identifier
  range. Both branches of the rule, in one response.
- The rule is language-neutral, and no language is named in the code that implements it.
- A gap found while fixing the search route: the conformance suite had no check for
  `workspace/searchSymbols` at all, so that route's shape was guarded only by adapter tests. **Closed
  by ADR-0031**, which gives search its own rule set — including the geometric rules that judge the
  empty selection range this ADR introduces — and records why `truncated` with an empty list has to
  stay legal there. It is closed for JetBrains, whose run records a real search response, and awaits a
  recording run for VS Code.
- The shape this ADR introduces is verified **beyond the adapter's own tests**. `RealDaemonSymbolsTest`
  drives a second document through the real daemon and records the response in
  `packages/conformance/captures/jetbrains.json`, where the shared rules judge it with the same
  functions they apply to the Java capture. That is what proves an empty selection range survives the
  daemon's authority check — a unit test cannot: a rejected result closes the session as a policy
  violation. It also puts `selection-range.well-formed` and `selection-range.within-declaration` in
  front of a symbol whose range spans no text, which no capture had contained before. Confirmed
  non-vacuous by mutating the recorded selection range one line past its declaration, which raises
  `selection-range.within-declaration`.
- The fallback PSI walk's half of the change is not directly covered by a test: every language in the
  test IDE that has named declarations also ships a structure view, so `PsiSymbols.declarations` never
  takes that branch for them. The rule it shares with the structure path is covered.

## Alternatives considered

### Keep skipping the row and hoist its members into the class

This is what the fallback PSI walk already did, so it would also have made the two paths agree.
Rejected: it reports `run` as a direct member of `Service`, which is the adapter inferring containment
— the exact judgement the structure model was adopted to stop making (see `StructureViewSymbols`) —
and it drops `Service.Companion`, a declaration both Kotlin and its Java interop name.

### Use the declaration's own range as the selection range

ADR-0017 does exactly this for `workspace/searchSymbols`, where `SymbolInformation` supplies one
range and nothing narrower exists. Rejected here because something narrower does exist and was
measured: the declaration range starts at annotations and modifiers, and consumers use
`selectionRange.start` as the position to run definition and reference providers at, where it would
resolve the annotation instead of the declaration.

### Name the declaration from the structure row's presentation text

Rejected. It is a rendering, not a name, and it produced `<class initializer>` and
`r: Runnable = new Runnable() {...}` in measurement. It also required Kotlin's Analysis API and threw
where analysis is prohibited, making a display string a correctness and threading hazard both.

### Refuse the document

Rejected. A file containing a companion object is ordinary Kotlin. Refusing every such document would
replace a partial answer with no answer.

### Special-case Kotlin

Rejected on the adapter's founding rule — it ships no language-specific knowledge — and unnecessary:
nothing in the fix names a language. The same rule serves any language whose PSI names a declaration
the text does not spell.
