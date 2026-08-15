# packages/conformance/src/

## Responsibility

**One implementation of the rules every IDEBP adapter must satisfy, whatever IDE is behind it.**

Conformance cannot demand identical answers: VS Code and JetBrains run different providers over
different languages, and a suite comparing outputs literally would fail on differences that are
correct. What it can demand is that the **shape** of an answer holds — a range that runs backwards, a
URI outside every registered root, or a handle bound to another session is wrong on any IDE.

Each rule here is one that has already cost something. The handle-binding rule is what the daemon
closes a session over; the containment rule is what makes a response a policy violation; the
truncation rule is what separates "this document is clean" from "nobody looked".

## The design that was built, and the one that was not

The original plan was a **runner**: connect to the daemon as a consumer, discover an adapter, execute
a scenario matrix. That was not built, and looking for it will waste your time.

What exists instead is the inverse. The rules are **pure functions over recorded responses**. Each
adapter's own end-to-end run — `RealDaemonSymbolsTest` for JetBrains, the extension-host suite for VS
Code — records what it actually put on the wire into `packages/conformance/captures/`, and the tests
here read those back and judge them.

The reason is ADR-0025: a runner able to drive both IDEs would have needed the rules restated in
Kotlin, and two implementations of one contract eventually disagree in a way nobody sees until a
consumer hits it. **So the responses travel instead of the rules.**

The cost is stated rather than hidden: a capture attests to the last end-to-end run, not to current
code. A stale capture would pass.

## Key functions (`invariants.ts`)

All seven are re-exported by `index.ts` (`export * from "./invariants.js"`), which is the public
entry point of the package. Each returns `Violation[]` — empty means conformant. None throws; a
malformed subject produces violations rather than an exception, because a suite that crashes tells
you less than one that reports.

- `checkWorkspace` (`invariants.ts:352`) — roots are URIs, root ids unique, every root contains
  itself (`workspace.has-a-root` `:356-358`, `workspace.root-contains-itself` `:367-370`). A
  workspace that breaks these makes every later response unverifiable, since there is no ground
  truth to check containment against.
- `checkDocumentSymbols` (`invariants.ts:92`) — walks the **whole tree**: a nested symbol that
  breaks a rule is as wrong as a top-level one, and checking only the roots is how a defect hides
  behind a correct first level. Enhanced with document pre-checks: `document.matches-request`
  `:96-101`, `document.belongs-to-workspace` `:102-107`, `document.current-epoch` `:108-113`,
  `locator.same-document` `:143`.
- `checkSymbolLocations` (`invariants.ts:169`) — covers all four location-carrying methods at
  once (`getDefinition`, `getReferences`, `getImplementations`, `getHierarchy`), which is the
  payoff of having given them one response shape. Enhanced with `truncation.implies-results`
  `:207-212`, `handle.unique` `:196`, `locator.within-a-root` `:200`.
- `checkDiagnostics` (`invariants.ts:291`) — severities, bounds, per-document uniqueness, and the
  `availableFixes` rules: an empty array is **not** an absent field, and fix ids must be unique
  within a diagnostic.
- `checkSearchSymbols` (`invariants.ts:237-289`) — validates `workspace/searchSymbols` responses:
  handle adapter/session/epoch binding, unique handle IDs, flat results (no children), locator
  within root, named symbols, well-formed ranges, selection range within declaration, result
  count within requested limit. **Opposite truncation semantics from `checkSymbolLocations`**:
  `truncated + empty` is legitimate for search (can reach scan ceiling before matching) but is a
  violation for locations (claims a cap on a list never filled, ADR-0017). Subject type:
  `SymbolSearchSubject` (`:41`).
- `checkEditPlan` (`invariants.ts:395`) — preconditions and changes agree, guarantees are not
  overclaimed.
- `checkModification` (`invariants.ts:444`) — every modified document was planned, and its hashes
  actually changed.

## Data & control flow

```
JetBrains RealDaemonSymbolsTest ──┐
                                  ├──▶ captures/*.json ──▶ tests/captured-adapters.test.ts
VS Code extension-host suite ─────┘                              │
                                                                 ▼
                                                    invariants.ts (one rule set)
```

The VS Code suite also applies these rules **in process**, on a live session, because it can hold
one. JetBrains cannot be driven from here, so it records. Both now record, which is what makes the
comparison real — for one increment only JetBrains did, and a cross-IDE contract was being checked
against one engine.

## Integration points

- Consumed by `packages/vscode-extension` (in-process, extension host) and by its own test suite.
- Depends on `@ide-bridge/protocol` for types and `isUriWithinWorkspaceRoot`.
- Captures are written **by** the adapters, never by this package.

## Common gotchas

- **A missing capture must fail, not skip.** Every VS Code check returns early when its part is
  absent, so a lost capture would take five checks quietly with it and the suite would go green
  having judged one adapter. That has already happened once, when a path bug meant the capture was
  never written and nothing said so. A guard now asserts both captures exist and are non-empty.
- **An empty answer satisfies every structural rule.** An empty symbol list, a plan with no changes,
  a hierarchy with no locations — all conformant, all worthless. The non-vacuity guard exists because
  two captures shipped in exactly that state.
- **Opposite truncation semantics between locations and search.** `checkSymbolLocations` treats
  `truncated + empty` as a violation (`:207`): truncation claims a ceiling was hit on a non-empty
  list, so zero results with truncation set claims a cap on a list never filled. `checkSearchSymbols`
  treats it as legitimate (`:237-289`): a workspace search can reach its scan ceiling before matching
  anything, so `truncated + empty` is a real outcome (ADR-0017).
- Conformance must not test unsupported capabilities as supported (TASK.md §22).
- Security scenarios and Unicode/CRLF/non-BMP coverage are mandated by TASK.md §22 and are **not yet
  here** — they live in the daemon and protocol suites today.
