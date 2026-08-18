# Status

What actually works, what does not, and what is deliberately deferred. Written to be read before
believing anything else in this repository: the plan log records how each piece was built, this
records where it stands.

Last updated: 9 August 2026.

## Verified end to end

"End to end" means a real IDE, a real daemon process, and a **separate consumer session** driving it
over the wire — never a mock, and never inferred from a descriptor.

| Adapter | Verified against | What was exercised |
| --- | --- | --- |
| VS Code | VS Code 1.132.0 extension host | Document read, symbols, workspace search, rename across files written to disk, a call-hierarchy step, refusal outside the workspace root |
| JetBrains | IntelliJ IDEA IC-2025.2 | Document read and revision, symbols from live PSI, diagnostics, navigation, prepare + apply rename written to disk |
| JetBrains | PhpStorm PS-253.32098.40 | PHP symbols from PhpStorm's own parser, rename applied and undone, a PHP quick fix chosen and applied, TODO markers read with the IDE's own patterns |
| JetBrains | GoLand GO-261.23567.143 | Go symbols, rename applied and undone, a Go quick fix applied, call hierarchy |
| JetBrains | PyCharm PY-262.8665.369 | Python symbols, rename applied and undone, a Python quick fix applied, call hierarchy |

Binary compatibility is separately measured with the IntelliJ Plugin Verifier against **IntelliJ
IC-252, PhpStorm PS-253, GoLand GO-261 and PyCharm PY-262** — all `Compatible`.

**All four have been run**, not merely measured. Each drives a different set of language engines
behind the same platform APIs, which is the only way to tell a plugin that uses the host IDE's
engines from one that merely compiles against them.

The JUNON tools are driven the same way, from a Serena process rather than a test harness. The
quick-fix path was exercised whole against IC-2025.2: `ide_apply_fix` with `confirm=false` returned
a plan naming one file and one edit and left the file byte-identical; with `confirm=true` the IDE
applied it — `public object StructureViewSymbols` became `object StructureViewSymbols` — and the
file was restored from a copy taken beforehand, checked by hash rather than assumed.

Two things had to be fixed before that run was even possible, and both were invisible to every test
suite. The Gradle sandbox lived inside the project it was asked to open, so the IDE spent its time
indexing 1.9 GB of its own caches — which is also where 190 of 200 TODO markers came from in one
measurement. And `jetbrains-plugin`'s module declared a content root with no source folders, so the
name index held nothing and the analyser never ran, for fifteen minutes at a stretch.

**Readiness is now announced rather than assumed.** `workspace/readinessChanged` had always been in
the protocol and the daemon had always handled it; the adapter never sent one, so `workspace/getStatus`
reported the state fixed at start-up — `initializing`, indefinitely, while search and diagnostics
worked perfectly. The adapter subscribes to the IDE's indexing transitions and announces the state it
computes at that moment. Measured after the change, at the first sample: `state: ready`, search
`truncated: false`, 52 diagnostics `truncated: false` — three routes agreeing about one instant,
which they previously did not.

**The IDE offers a link to the JUNON dashboard.** Its port cannot be guessed — four dashboards were
running on one machine in one evening, on 24282, 24283, 24284 and 24286 — so each Serena process
publishes an entry naming its own URL, pid and start time, and the plugin shows only the entries
still published by the process that published them. A link to a stopped dashboard is worse than
none. Confirmed on screen, and the link opens the dashboard.

**And a pid is not a process.** The entries outlive the processes that write them — twenty were found
in one directory, the oldest three days old, all but one dead — so a reader that trusted the pid alone
would eventually offer a link to whatever inherited the number. The start time is what settles it.
Measured on a live entry, both readers agreeing about one process: Python recorded
`started_at: 1786953493.905149`, the JVM's `ProcessHandle.startInstant()` reported
`1786953493.905` for the same pid, **149 µs apart** against a two-second tolerance, and the entry was
accepted. The nineteen dead entries beside it were pruned as they were read. Both sides are held to
this by mutation: an entry with a live pid and a mismatched start time must be refused, and making
either reader accept it fails exactly one test.

## Method coverage

The protocol routes 16 methods to adapters.

| Method | VS Code | JetBrains |
| --- | --- | --- |
| `document/read` | served | served |
| `document/getRevision` | served | served |
| `document/getSymbols` | served | served |
| `workspace/searchSymbols` | served | served |
| `workspace/searchTodos` | not served | served |
| `workspace/listBookmarks` | not served | served |
| `symbol/resolveAt` | served | served |
| `symbol/getDefinition` | served | served |
| `symbol/getReferences` | served | served |
| `symbol/getImplementations` | served | served |
| `symbol/getHierarchy` | served | served |
| `diagnostics/getSnapshot` | served | served |
| `refactor/prepare` | served | served |
| `refactor/prepareRename` | served | served |
| `workspace/applyPlan` | served | served |
| `workspace/discardPlan` | served | served |
| `workspace/undo` | not served | served |

Anything not served is declared `unavailable` **with a reason** rather than omitted, so a consumer
receives a truthful refusal instead of an unexplained absence. The three VS Code gaps are principled,
not unfinished: VS Code has no scoped undo, no TODO index, and no bookmarks of its own.

## The rule the JetBrains adapter is built on

**No language-specific code.** What the adapter can do is whatever the IDE hosting it can already do
— symbols from the IDE's structure model, navigation from `ReferencesSearch` and
`DefinitionsScopedSearch`, formatting from `CodeStyleManager`, TODO patterns from the user's own
settings.

A Java-specific classifier was written and then deleted: the Plugin Verifier measured seven
compatibility problems it caused in PhpStorm and GoLand.

Four IDEs turn the rule from a claim into an observation, because each labels declarations in a
vocabulary the adapter has never heard of:

| IDE | What `declarationType` carries |
| --- | --- |
| IntelliJ | `CLASS`, `METHOD`, `FIELD` |
| PhpStorm | `CLASS`, `CLASS_METHOD`, `CLASS_FIELD` |
| GoLand | `TYPE_SPEC`, `METHOD_DECLARATION`, `FIELD_DEFINITION` |
| PyCharm | `Py:CLASS_DECLARATION`, `Py:FUNCTION_DECLARATION`, `Py:TARGET_EXPRESSION` |

Nothing branches on any of these strings, which is exactly why a fifth IDE needs no work. Relocation
uses `declarationType` and not `kind`, deliberately: a discriminator must be present for every
declaration, and `kind` is not.

`symbol.kind` was `unknown` everywhere until 2026-08-09 — the `symbolKindMapper` extension point had
no implementations and nothing outside this repository knew it existed, so the field was dead in
every IDE. `PlatformSymbolKindMapper` now supplies it from the answer each language already gives
the platform for Find Usages, matched against the protocol's own vocabulary and used only on an
exact hit. Java yields `class`, `interface`, `enum`, `constructor`, `method`, `field`; Kotlin yields
`class`, `interface`, `object`, `property`, `function` — with no language named anywhere in the
code, and verified Compatible against IntelliJ, PhpStorm, PyCharm and GoLand.

Two limits are kept rather than smoothed over. A language that names two vocabulary words at once —
Java's `constant field`, Kotlin's `companion object` — is left `unknown`, because choosing between
them would be this adapter's judgement rather than the IDE's. And the platform normalises only as
far as each language does: Kotlin answers `class` for an `enum class` and for its entries alike,
where Java distinguishes `enum` from `enum constant`. That coarseness is reported as given.

Reading the IDE's model also means reporting what is in it. A structure row the adapter cannot address
— a grouping node, an anonymous declaration — is **transparent**: the declarations inside it are still
reported. Until 2026-08-09 it was opaque, and that cost a measured price: a Kotlin `companion object`
is named `Companion` by the language while no text spells that name, and the adapter dropped the row
together with every factory function and constant inside it, answering an ordinary file with silence.
Such a declaration is now reported, with an **empty selection range** at the offset the platform
navigates to — there is no identifier text to claim, and `refactor/prepareRename` refuses the element
for the same reason, so the empty range and the refusal say one thing. **ADR-0030** records it,
including why the declaration's own range was rejected as a stand-in.

Transparency has one limit, and it took a real IDE to find it. **A declaration reported inside
another must lie inside it.** Running PyCharm against this repository's own Python, a class
declaring a single method came back with four: the three it inherits arrived beneath it carrying
their base class's ranges, so the same declarations appeared twice in one document and a member's
address pointed into a class that was not its own — an agent editing it would have changed every
subclass instead of one. The adapter already refused inherited rows whose base class lives in
another file; that guard was written for this exact problem and could not see it, because both
classes shared a file. The rule that replaced it is textual and names no language: inheritance,
traits and mixins differ everywhere, containment does not.

The first test written for it asserted the right thing about the wrong language and **proved
nothing** — an isolated mutation passed four Java assertions identically with the rule present and
removed, because Java's structure model offers no inherited rows at all. The rule is now exercised
where it lives, on the shape of the tree, with real PSI and authored nesting.

How far the problem reaches was measured rather than assumed, by running the same file through a
real PhpStorm twice, once with the rule removed. `User` uses a trait declared above it in the same
file — the shape that defeated the cross-file guard — and the two runs were **identical**: PHP does
not place a trait's members inside the class that uses it, and neither does Java with inheritance.
Among the languages driven so far only Python's model does. So this is one language model's
behaviour rather than a platform-wide one, and the rule is written to be indifferent to which.

`workspace/searchSymbols` had the same rule twice over, and the same measurement caught it: the IDE's
"Go to Symbol" index offers the name `Companion`, and the route returned nothing while reporting
`truncated: false` — an omission presented as a complete answer. Both routes now read one rule, so a
name found in a document can also be found by searching for it.

Neither claim rests on unit tests alone. The end-to-end run drives a second document through the real
daemon and records what came back in `packages/conformance/captures/jetbrains.json`, where the shared
rules judge it — which is the only way to show that a symbol carrying an **empty** selection range
survives the daemon's authority check rather than closing the session. Search was also the last symbol route with no shared rule of its own, which is how the omission above
survived — nothing outside the adapter looked at the shape it returned. **ADR-0031** gives it one, in
the same implementation that judges every other route, and records what is deliberately *not* a rule:
`truncated` with an empty list is honest here, because the name scan has a ceiling of its own. One limit
stays stated rather than closed — the rules judge JetBrains' recorded answers today and VS Code's the
moment an extension-host run records one, so cross-adapter parity on this route is pre-wired, not
achieved.

## Which projects are bridged

A tool window (**IDE Bridge**, right edge) states whether a daemon is reachable, and then gives **every
project the IDE has open** a row: its name, whether it is linked and to which workspace, and Link /
Unlink for that project. Any open project can be linked from any window's panel — a panel that could
only act on its own project could name the others but not reach them, so exposing one meant walking to
its frame first.

It exists because that was previously decided by accident. One application-wide connection was taken by
the first project opened, released only at IDE shutdown; closing a project killed the serving thread and
the daemon dropped the adapter while the flag stayed set, so **every project opened afterwards was
ignored without a log line** until the IDE restarted. Found by running a real IDE, not by a test — no
fixture opens a second project. **ADR-0033** records it, with the measurements.

Each linked project has its own session, so a consumer sees one adapter per project. Several projects on
a *single* session is a protocol question, not an adapter one: `ide/register` creates an adapter and its
workspaces in one call and nothing adds a workspace to a live session. That is stated in the ADR rather
than left to be discovered.

## Edit operations

**Reachable from Serena since `ide_refactor`.** Until it existed, JUNON's only editing tool hard-coded `quickFix`, so `rename`, `reformat` and `optimizeImports` were served by both adapters, exercised in the demo and reachable by nobody — the one refactoring an IDE does better than anything else was missing from the integration built to expose it. The tool prepares and applies inside a single session, because a plan carries the id of the session that made it, and refuses to resolve an ambiguous name rather than renaming the first match. Both guarantees are held by mutation.

**Run against a live IDE**, on IC-252.23892.409 with this repository's `jetbrains-plugin` open. Renaming `dashboardLine`, which is declared in one file, called from a second and asserted in a third:

```
preview   BridgePanelModel.kt 1 edit · BridgeToolWindowFactory.kt 1 · BridgePanelModelTest.kt 3
          git status: clean          <- nothing written
apply     3 document(s) changed by the IDE
on disk   dashboardLine: 0 in code, 2 left in codemap.md
```

The two survivors are the measurement worth keeping: `codemap.md` mentions the symbol in prose, and the IDE left it alone because a rename follows references its engine resolved, not text that matches. A `sed` would have edited the documentation and called it the same operation. The tree was restored with `git checkout` afterwards, and the response carries a before and after hash per document, so a caller can check the same thing without trusting the summary.

Four PhpStorm windows on the user's own projects were connected to the same daemon throughout, having linked themselves after the restart that loaded the plugin — the first time the adapters have run outside a sandbox. Nothing was written in any of them.


The plan vocabulary is `rename`, `reformat`, `optimizeImports`, `extractMethod`, `inline`, `move`,
`changeSignature`, `quickFix` — all through the same two-phase machinery.

**Four have behaviour**: `rename`, `reformat`, `optimizeImports`, `quickFix`.

**Four are refused by name**: the structural refactorings. That refusal is measured, not unfinished
work — the platform's only language-neutral route to them is a dialog-driven
`RefactoringActionHandler`, which cannot run behind a socket. **ADR-0028** records the three rejected
alternatives, and its probe test fails if a future platform offers a non-UI handler, so the decision
cannot quietly go stale.

## `workspace/undo`

Implemented through the IDE's own undo stack, with the editor passed explicitly rather than inferred
from focus — IntelliJ would otherwise revert whichever editor happens to be focused, which can be a
document the plan never named.

Verified against PhpStorm: prepare a semantic rename, apply it, undo it; the consumer receives
`changed: true` and the file on disk is back to its original text.

This closed a defect that survived **six** wrong explanations. The cause, once the refusal named
itself: undo reverts the **document**, but PSI only catches up when committed, so the adapter read
the pre-undo text and reported a modified document whose hashes matched. The daemon refused it —
correctly, since that is indistinguishable from claiming a modification that never happened.

## Hierarchies

A hierarchy is walked **one level at a time**, with a named relation — `callers`, `callees`,
`subtypes`, `supertypes` — so a consumer never has to know whether an IDE models "up" as supertypes
or as callers. The response reuses the `locations + truncated` shape, inheriting the daemon's
containment and handle checks without a new validation path.

The distinction that makes it a hierarchy rather than a reference list: **a caller is the declaration
containing a reference, not the reference itself.** Mutating that fails the tests, and GoLand and
PyCharm both confirmed it over the wire — the caller lands on the declaration, one line above the
call site.

**`supertypes` is refused on JetBrains and served on VS Code.** Each adapter serves what its IDE can
rather than levelling both down to the smaller set.

## Quick fixes

A fix an agent cannot see is one it would have to guess at, so the offer is published before anything
can apply it. A diagnostic carries `availableFixes` — an opaque `fixId` and the IDE's own wording.
The id is a handle to pass back, never a command the adapter interprets, and it is **re-derived at
prepare time** rather than remembered, so a superseded offer fails closed instead of applying
whatever now sits in its place.

**JetBrains applies them in three IDEs**: `Unused declaration` (PhpStorm), `Optimize imports`
(GoLand), `Remove assignment target` (PyCharm) — chosen by a consumer, prepared, applied, replay
refused.

**VS Code prepares and applies them under unit test and mutation proof, with no real-host run** — for
the platform reason below, not for want of work. Its offers are fetched only for documents the
consumer names, and only for the first 20 diagnostics of each: VS Code computes fixes on demand, and
on a project sweep that cost is a route timeout.

Two conformance rules, both mutation-proven: an empty array is not an absent field (omitting means
the adapter did not look; `[]` means it looked and found none), and fix ids must be unique within a
diagnostic.

Three defects were found getting there, each by measurement — a `fixId` past the protocol's 128
characters, an `IntentionAction.text` that reads `(not initialized) class …` until the platform
initialises it, and titles arriving wrapped in `<html>`. The last two were caught by **reading a
capture**, not by a failing test.

## A VS Code boundary, measured

**VS Code publishes diagnostics only for documents that are visible**, and quick fixes follow them.

Measured on a file carrying a deliberate error: `openTextDocument` left it tracked in
`workspace.textDocuments` and still produced no diagnostic; pulling document symbols produced none;
pulling code actions produced eight actions of which **every one was a `refactor.*` and none a
`quickfix`** — TypeScript computes fixes from the diagnostics it holds for a range, so with nothing
published there is nothing to fix.

The JetBrains approach — open an editor without focus, ask the analyser to run — has no VS Code
equivalent. Closing this would mean putting a file on the user's screen to answer a background
request, which is further than an adapter should go.

Refactorings *are* reachable on an unopened file. That is a different capability, noted rather than
built.

## Refusals name themselves

Every `PROVIDER_FAILED` closes the offending adapter's session, and all of them used to carry a code
and nothing else — the failure mode that cost six wrong explanations of one `workspace/undo` defect.

**All 18 router sites now name their condition**, on the edit path and the symbol/diagnostics path
alike. The adapter had the same defect and kept it longer: `AdapterRouter.route` wrapped every
handler and **discarded the exception**. It now logs the cause while the wire answer stays
`PROVIDER_FAILED` — an exception message can carry file text and must not travel.

Three guards keep it, all mutation-proven: no bare `PROVIDER_FAILED` in the router, every literal
close reason within the 123-byte close frame, and the VS Code capability check compared against the
protocol **source** rather than a build that can be stale.

The 123-byte guard exists because exceeding the limit does not truncate — it makes `close()` throw,
leaving a contract-violating adapter connected.

## Conformance

Both adapters record a capture from their own end-to-end run, and **one rule set judges both** across
workspaces, document symbols, hierarchies, edit plans and modifications. Two rename engines, two
symbol providers, no exception carved for either.

A missing capture, or an empty hierarchy inside one, fails — because every VS Code check returns
early when its part is absent, and a lost capture would otherwise take five checks quietly with it.

## Test counts

| Stack | Tests | Notes |
| --- | --- | --- |
| TypeScript | 474 across 55 files | Plus 171 schema entries and 49 protocol fixtures |
| Kotlin | 287 across 54 classes | Includes platform-fixture and real-daemon suites |
| Python | 190 | The JUNON tools and their Serena composition |
| Conformance | 54 | Judges two captured adapters. **Inside** the TypeScript figure, not additional to it — it runs under the same vitest invocation, and this row read as a separate suite until it was counted |
| VS Code host | 9 scenarios | Runs a real extension host it starts itself, and records a capture |

## Known limits of the verification itself

- A conformance **capture** attests to the last end-to-end run, not to the current code. A stale
  capture would pass.
- **The Python suite runs against one Serena, and that hid a fatal defect.** Everything here is
  pinned to the development checkout (1.7.1.dev0), so a composition that only works on *that*
  version passed every test and `compose()` reported itself complete. Composed onto an ordinary
  `pipx install serena-agent` (1.5.3) it killed the server on start-up: `run_in_thread` is declared
  `(self, host)` there and `(self)` in 1.7, and our override — fixed to the newer shape — raised
  `TypeError` inside the agent's constructor. Fixed by passing the arguments through, and now
  covered by tests that call both shapes with upstream faked out, plus a seam test that fails if the
  override is ever narrowed again. Measured after the fix: the injected `junon` starts on 1.5.3,
  publishes its dashboard on 24282 and serves JUNON's page. **The suite still exercises one version**
  — the second is reached by fakes, not by installation.
- **Only two of the six document notifications remain unobserved.** `document/opened`, `changed`,
  `saved`, `deleted` and `diagnostics/changed` have all been seen leaving the JetBrains adapter.
  `document/renamed` fires only for a rename made inside the IDE — a disk rename is reported as a
  deletion, correctly — and `document/closed` needs a person closing a tab, since the adapter opens
  editors and never closes them. Both shapes are schema-verified on both stacks.
- **A JetBrains link the daemon ends now reconnects itself**, with a widening delay capped at 30 s
  and abandoned after six attempts — a refused response must not become a retry flood. Proved against
  a real daemon: killed, restarted on the same discovery file, and the plugin found its way back.
- **The adapter has now answered from a language engine it was not written against.** PyCharm reports
  Python symbols with real kinds and no `unknown`, and refuses diagnostics by name on a project with
  no interpreter. Both IDEs were connected to one daemon at the time, which is also the first
  exercise of multi-adapter routing. A genuinely third-party (marketplace) plugin remains untested.
- **The two adapters report readiness differently, and neither pretends otherwise.** JetBrains
  probes every 5 s and can say `degraded`; VS Code announces `ready` once and never says `indexing`
  or `degraded` — it exposes no index-readiness signal (ADR-0019), and its extension host has one
  thread, so a watchdog inside it could not run while the thing it watches is blocked. What happens
  there instead is that the heartbeat stops and the daemon expires the session. Until 2026-08-15 VS
  Code announced nothing at all, so the daemon left every one of its workspaces at `initializing`
  for as long as the editor was open.
- **Readiness is pushed, and now watched.** `workspace/getStatus` is answered by the daemon from the
  adapter's last `workspace/readinessChanged`; the request never reaches the IDE. Announcing only on
  dumb-mode transitions meant an IDE that stopped answering for any other reason still read `ready` —
  measured at 0.00 s while three routes failed at exactly the 30 s route timeout, the IDE blocked on
  a modal dialog. A 5 s watchdog now probes whether a read action can run and reports `degraded`
  when it cannot ([ADR-0039](adr/0039-readiness-is-watched-not-remembered.md)); it is the first
  `degraded` any adapter in this project emits. Proved live for the quiet case — roughly two hundred
  ticks, one announcement — and by unit test and mutation for the blocked case, which no longer
  reproduces on demand now that applying saves its documents.
- **An edit made on disk, outside the IDE, used to reach it on no schedule you could rely on** — one
  run still reported the old content after ninety seconds, another noticed at forty-five. IntelliJ
  refreshes its virtual file system on frame focus, and an IDE driven by an agent may never be
  focused. The adapter now requests that refresh itself every 15 seconds, and a file written on disk
  is visible in about five. Applying a plan additionally refreshes the files it names before checking
  them, so an edit made underneath is refused rather than written over.
- **A Kotlin suite could report success without reading the fixtures it judges by.** The shared
  protocol fixtures are read at run time, which Gradle cannot see from the classpath, so changing one
  left `:test` up to date. Measured on 2026-08-15: five notification fixtures were added for which
  the Kotlin side had no serializer at all, and the suite went green; only a forced rerun showed it.
  The fixtures directory is now a declared input, proved by changing a fixture's content and watching
  the task execute.
- **A pid outlives the process it named, and the registry trusted it anyway.** Both readers of the
  dashboard registry decided an entry was live from the pid alone, while both files carried a comment
  saying a link to a dead port is worse than none. Twenty entries were found in one directory, the
  oldest three days old, nineteen dead — each one an offer waiting for its number to come round on an
  unrelated process. Entries now carry the publishing process's start time and both readers require
  it to match, within a tolerance measured rather than guessed
  ([ADR-0040](adr/0040-a-pid-does-not-identify-a-process.md)). Proved by mutation on both sides, and
  on a live entry: 149 µs between what Python wrote and what the JVM read back for the same process.
- A green suite says nothing about a path it never takes. Every JetBrains rename test renamed within
  one file, so four defects lived in the cross-file path — including a **stale plan being applied**,
  the exact failure §30 step 12 exists to prevent
  ([ADR-0038](adr/0038-the-party-that-applies-a-plan-checks-it.md)). All four were found by driving a
  real IDE, in sequence: each was invisible until the one before it was fixed.
- Until 2026-08-14 the VS Code end-to-end suite did not attest to *this build at all*: it attached
  to whatever daemon was listed in `$HOME/.ide-bridge/discovery.json`, because the extension read an
  empty discovery-file setting as a configured one and never consulted the sandboxing environment
  variable. Three days of measurements were taken against a daemon nobody had rebuilt
  ([ADR-0037](adr/0037-an-integration-test-must-name-the-process-that-answered.md)). The run now
  logs `daemon-autostarted`, which is the only evidence that separates the two cases.
- The plugin's internal-API surface is two symbols, both required to read the IDE's diagnostics, both
  baselined with a reason. There is no public alternative.
- A hierarchy needs a position on the identifier. A `workspace/searchSymbols` handle carries the
  declaration's start, so the VS Code adapter refines it — without that a consumer got a silently
  empty answer.
- Everything is measured against **bundled** language support. No third-party plugin has been
  installed and observed.

## Deferred by decision, not by oversight

Run configurations, the debugger, the terminal and VCS. They collide with the rule against executing
arbitrary IDE commands, and a passthrough is exactly what that rule forbids. Whenever they are taken
up, the design must be an **enumerated** surface — "start the existing configuration named X", never
"run this" — with the runnable set coming from the IDE and never from the request.

## Noted for later

**A completion method.** The protocol asks for symbols, navigation, diagnostics and edits, but never
for completions — so the most visible thing a language plugin provides is unreachable, not because
the extension is hidden but because no method poses the question. Both sides have an aggregating
surface: IntelliJ's `CompletionService`, VS Code's `executeCompletionItemProvider`.

**Third-party plugin verification.** The design says a third-party inspection lands in
`diagnostics/getSnapshot` and its fixes in `availableFixes`, because both come from surfaces plugins
register into. No third-party plugin has been installed and observed, and this session showed
repeatedly that the gap between "the design says yes" and "measured" is where defects live.
