# Demonstration procedure

The reproducible walkthrough TASK.md §30 asks for: one run per adapter, plus the Serena integration.

Where a step's outcome was measured, the measurement is quoted rather than described — a demo script
that says "the plan is refused" without ever having watched it be refused is the kind of document
this project exists to avoid.

One part has **not** been run and says so in place: step 12 of the JetBrains walkthrough. Everything
else was executed against a running daemon and a running IDE, and the output shown is what came
back.

## Before any demo

The daemon is the fixed point: adapters connect to it, consumers connect to it, and it is started
before either.

```bash
export IDE_BRIDGE_DISCOVERY_FILE=/tmp/ide-bridge-demo.json
node packages/cli/dist/bin.js daemon
```

It publishes its endpoint and token to that file, `0600`. Leave it running; every command below
reads the same variable.

Check it is up, from another shell with the same variable exported:

```bash
node packages/cli/dist/bin.js status
```

Measured:

```json
{"ok":true,"command":"status","result":{"daemonVersion":"0.0.0",
 "protocol":{"minimum":"0.1.0","maximum":"0.1.0"},"adapterCount":0,"workspaceCount":0}}
```

`adapterCount: 0` is the point — nothing is connected yet, and the daemon says so rather than
waiting for something to appear.

**Then ask which daemon that is**, before trusting anything it says:

```bash
node packages/cli/dist/bin.js doctor
```

Measured on a machine where a daemon had been left running since Tuesday:

```json
{"ok":true,"checks":[…all pass…],
 "daemon":{"discoveryFile":"/Users/…/.ide-bridge/discovery.json","pid":48591,
           "startedAt":"2026-08-11T13:45:41.184Z","uptimeSeconds":240063}}
```

Every check passes and the process is nearly three days old. That combination is what cost this
project three days of wrong conclusions, so `doctor` now names the daemon alongside its verdict. It
repeats neither the token nor the endpoint — a diagnostic gets pasted into issues.

## JetBrains demo

### 1–3. Start the IDE with the plugin, on a project

```bash
cd jetbrains-plugin
export IDE_BRIDGE_DISCOVERY_FILE=/tmp/ide-bridge-demo.json
export IDE_BRIDGE_SAMPLE_PROJECT=$PWD          # or any project with source roots
./gradlew runIde                                # runPhpStorm / runPyCharm / runGoLand also exist
```

**The project must declare source roots.** A directory opened with none has an empty index and no
analyser, and the adapter says so — see *When the project is not analysable* below. This was not a
theoretical concern: it cost a whole session's worth of confusion before the adapter refused it out
loud.

### 4. Verify the registration

```bash
node packages/cli/dist/bin.js adapters
node packages/cli/dist/bin.js workspaces
```

Measured:

```json
{"adapters":[{"name":"IDE Bridge for JetBrains","version":"0.1.0",
  "ideKind":"jetbrains","ideVersion":"IC-252.23892.409","capabilities":{...17 methods...}}]}
{"workspaces":[{"workspaceId":"ws_zFMa4M36S2sFdJOag7bdLoqi","name":"jetbrains-plugin",
  "roots":[{"uri":"file:///…/jetbrains-plugin"}],"trust":"trusted"}]}
```

The workspace id is what every later call needs; it is issued by the daemon and cannot be invented
(`^ws_[A-Za-z0-9_-]+$`).

### 5. List the symbols of a document

`document/getSymbols` with `{workspaceId, uri}`. Measured on a Kotlin file: five top-level symbols,
each with a real kind — `class`, `function`, `method`, `property` — from the language's own parser.

### 6. Search, and find references

`workspace/searchSymbols` with `{workspaceId, query, kinds?}`. The `kinds` filter is applied by the
IDE while results are collected, so a rejected kind does not spend the caller's limit. Measured:
`query: "User", kinds: ["class"]` returns classes only; without the filter the same query also
returns methods.

`symbol/getReferences` and `symbol/getHierarchy` take a symbol reference — the `handle` and
`locator` a search or a document listing already returned.

### 7–10. Prepare a plan, show it, apply it, show what changed

**Both calls must share one connection.** A plan carries the id of the session that created it;
preparing on one connection and applying on another is refused `PLAN_NOT_FOUND`. Measured both
ways.

`refactor/prepare` with `{workspaceId, operation, uri, arguments}` returns a plan:

```json
{"planId":"plan_8th3HIdv1cfG6PKv4wPvZhsZ","operation":"quickFix",
 "guarantee":"semantic","atomicity":"semantic",
 "changes":[{"kind":"textEdit","uri":"file:///…/StructureViewSymbols.kt","editCount":1}],
 "warnings":[]}
```

Nothing is written by preparing — verified by hashing the file before and after.

`workspace/applyPlan` with `{workspaceId, planId}` performs it and names what changed:

```diff
- public object StructureViewSymbols {
+ object StructureViewSymbols {
```

The response carries `modifiedDocuments` and an `undoToken`. The token belongs to the same session:
`workspace/undo` works on that connection and is refused `PLAN_NOT_FOUND` from another.

### 11–12. Make the plan stale

Two plans are prepared on one document, the second is applied, and the first — now describing text
that has moved — is offered. Measured, in one session against a real IDE:

```
StructureViewSymbols: plan plan_ScIB… touches [PsiSymbols.kt, StructureViewSymbols.kt,
                                               AdapterBackend.kt, …6 files]
declarations:         plan plan_GtOG… touches [StructureViewSymbols.kt, InheritedMembersTest.kt]
applied B (declarations): ['StructureViewSymbols.kt', 'InheritedMembersTest.kt']
RESULT plan A (StructureViewSymbols): refused [STALE_DOCUMENT] retryable=False
        STALE_DOCUMENT: Document changed after the plan was prepared
undo: accepted
```

The refusal comes from the **daemon**, which never forwards the request: applying a plan now
announces `document/changed` for each document it touched, so the store invalidates what depended on
them and answers with the revision to prepare against. Before that notification existed the same
scenario answered `PRECONDITION_FAILED` from the adapter — correct, but later and less useful, since
a consumer told only "stale" has to guess what to re-read.

The change is made **through the IDE**. Writing the file on disk instead does not invalidate
anything — the IDE holds its own copy and never saw the write, which is worth knowing for anyone
editing a bridged file in a second editor.

Getting here required fixing four defects, none of which any test suite had caught, because every
existing test renamed within a single file:

| Defect | What it did |
| --- | --- |
| One precondition per plan, not per changed document | Every cross-file rename was refused, and the refusal closed the session |
| The apply reported one modified document | Same, one phase later — after the consumer had committed |
| `claim` never checked the plan's preconditions | A stale plan was **applied**: edits for offsets that had moved were written, and only then refused |
| PSI read before the editor's document was committed | The check above passed on text the user had already changed |
| No document notification was ever sent | The daemon's own plans stayed live against documents this adapter had just rewritten |

The third is the one step 12 exists to prevent, and it was live until 2026-08-14.

**What a consumer can rely on, and what it cannot.** This adapter announces `document/changed` twice
over, on purpose: immediately for the edits **it** performs — an applied plan, an undo — so a plan
invalidated by the previous call is already stale before the next one arrives; and after a 400 ms
quiet interval for everything the editor changes, coalesced per document so a burst of typing is one
notification rather than fifty. Measured: an applied two-file rename produces four notifications, two
from each path.

The rest of TASK.md §12's vocabulary is now sent too — `document/opened`, `saved`, `closed`,
`renamed`, `deleted` and `diagnostics/changed`. Three are proved end to end; a six-file rename with
its undo, watched by a consumer, produced:

```
document/changed      x19
document/saved        x12
diagnostics/changed    x2
```

`document/opened` and `document/deleted` are proved too, by a probe that writes a file, asks for its
diagnostics — which makes the adapter open an editor for it — then deletes it:

```
   5.3s  the IDE sees the new file
   8.8s  document/opened      FivePointsProbe.kt
  21.7s  document/deleted     FivePointsProbe.kt
```

**`document/renamed` fires only for a rename made inside the IDE.** Renaming on disk produces
`document/deleted` instead, and correctly so: a file-system refresh discovers an absence and a new
file, it does not reconstruct a move. **`document/closed` needs a person closing a tab** — the
adapter opens editors and never closes them, and a file deleted while open is reported as deleted,
not closed, since a document that is gone has no revision to name. Both shapes are verified against
the schema on both stacks; neither has been observed leaving the adapter.

`node packages/cli/dist/bin.js status` is the cheapest way to see all of this: the daemon counts every
method it routed, and the counts are what tell an adapter's author whether a notification is arriving
at all.

Their *payloads* are proven, which is the part that could have been fatal: a notification the daemon
rejects closes the adapter's session, so a wrong shape would have taken the bridge down the first
time a user opened a file. Fixtures now exist for all five, and adding them immediately showed that
the Kotlin side had no serializer registered for any of them — they had never been confronted with
the schema at all.

**An edit made on disk, outside the IDE** used to reach it on no schedule worth relying on: one run
still reported the old content after ninety seconds, another noticed at forty-five. The cause is that
IntelliJ refreshes its virtual file system when its frame regains focus, and an IDE driven by an
agent may never be focused at all. The adapter now asks for that refresh itself every 15 seconds,
scoped to the workspace's roots and asynchronous. Measured after the change: **a file written on disk
is visible to `document/getRevision` in about five seconds.**

So `workspace/applyPlan` refreshes the files its plan names before checking them — only those the
editor holds unmodified, because refreshing a modified document raises the IDE's "reload from disk?"
dialog, and a dialog nobody answers blocks the IDE outright. Measured with the apply issued
immediately after the disk write, before any refresh could have happened on its own:

```
edited the file outside the bridge
  the IDE has not seen the edit yet
RESULT: refused [PRECONDITION_FAILED] by the adapter
```

The IDE had not noticed, so the daemon had not been told, and the plan was still refused — the check
reads the file rather than the IDE's memory of it. Left alone for long enough, the same scenario is
refused by the *daemon* with `STALE_DOCUMENT` instead, once the refresh reaches the document listener.
What a consumer must still know: symbols and diagnostics keep describing the IDE's view, which can
lag the disk by a minute or more.

**`ready` does not mean the IDE can answer.** This bears stating plainly, because two wrong
explanations were written here first.

`workspace/getStatus` is answered by the **daemon**, from the last `workspace/readinessChanged` the
adapter pushed. The request never reaches the IDE. The JetBrains adapter pushes on dumb-mode
transitions, so an IDE that stops being able to serve for any other reason keeps its last announced
value — `ready` — indefinitely. Measured: `getStatus` answering `ready` in 0.00 s while
`document/getRevision`, `document/getSymbols` and `workspace/searchSymbols` all failed at **exactly
30.00 s**, the route timeout. They were not slow; they were never served.

Two causes were found for that, and neither is an indexer:

- **The adapter's session had been closed** and the daemon had not yet noticed, so requests routed
  to a workspace with nobody behind it.
- **The IDE was waiting on a modal dialog.** The demo scripts restore fixture files by writing them
  back to disk; when the IDE holds those documents modified in memory, it raises
  `MemoryDiskConflictResolver` — *"reload from disk?"* — and blocks its event thread on a click
  nobody will make. Every route needing a read action then times out. Visible in `idea.log`:

  ```
  MemoryDiskConflictResolver - reload StructureViewSymbols.kt from disk?
    documentStamp:1972  oldFileStamp:1409
  ```

  Prefer `workspace/undo` to restore, and if you must write behind the IDE's back, expect to answer
  its question or restart it.

An earlier version of this note said a large rename leaves the IDE re-indexing for minutes. Probed
directly, that is false: at rest and at 0, 5, 20 and 50 s after a six-file rename every route answers
in under 0.1 s.

**This is now watched rather than assumed.** A 5 s heartbeat asks whether a read action can run
within 2 s — the same question every route asks — and announces `degraded` when it cannot, naming
every method it cannot serve, `document/read` included
([ADR-0039](adr/0039-readiness-is-watched-not-remembered.md)). It announces only on change: across
roughly two hundred ticks in seventeen minutes, exactly one announcement went out. Opening a project
now reads `smart → dumb → blocked → smart` in the IDE's log; all four of those moments used to read
`ready`. `degraded` had never been emitted by any adapter before this.

Before trusting any of this, read the VS Code section below: the same step failed there for three
days against a daemon nobody had noticed was the wrong one.

## VS Code demo

Run by one command, against a real VS Code that this repository drives itself:

```bash
cd packages/vscode-extension
pnpm test:integration
```

It downloads and launches VS Code, installs the extension, opens `examples/typescript-project`,
runs the walkthrough, and restores the fixture files afterwards — the rename scenario writes to
them, and a fixture is a committed contract rather than scratch space.

Measured:

```
✔ the registered workspace satisfies the conformance rules
✔ reads a fixture document with a revision from the live buffer
✔ returns the symbols the language contract declares, at the declared ranges
✔ finds the rename target across the workspace and lists its references
✔ answers a hierarchy step and records it for the conformance suite
✔ answers a hierarchy from a workspace-search handle, whose position is coarse
✔ renames across exactly the declared files and writes them to disk
✔ refuses a plan whose document changed after it was prepared
✔ refuses to read a document outside every workspace root
9 passing
```

That covers steps 4 through 12.

### Step 12 — the plan that should be stale, and the three days it cost

This step passes on VS Code, and the way it started passing is worth more than the step.

**The refusal itself.** IDEBP's `STALE_DOCUMENT` is not a bare code: its data carries the revision
the document has now, so a consumer can re-read exactly that and prepare again. Until 2026-08-13 an
invalidated plan was simply deleted and the next `applyPlan` answered `PLAN_NOT_FOUND` —
indistinguishable from a mistyped identifier. The store now remembers why a plan was dropped,
briefly and boundedly. `in-memory-edit-store.test.ts` proves both halves, including that a *deleted*
document still gets `PLAN_NOT_FOUND`, because a file that is gone has no current revision to name.

**Then it refused to reproduce.** Driving it end to end kept answering `PLAN_NOT_FOUND`, and five
explanations were offered and checked: the 75 ms debounce (waiting 750 ms changed nothing), a stale
bundled build, a URI mismatch, a missing revision, and a notification dropped silently by the
extension's event bridge. Every one of them was wrong.

**The suite was not talking to the daemon it built.** `readAdapterConfiguration` passed the
`ideBridge.discoveryFile` setting straight to the resolver, and that setting's declared default is
the empty string — which the resolver reads as a configured path rather than as an absence. So
`IDE_BRIDGE_DISCOVERY_FILE`, exported by the launcher precisely to sandbox the run, was never
consulted: extension and consumer both attached to `$HOME/.ide-bridge/discovery.json`, a daemon
started by hand three days earlier, from a build that contained no `STALE_DOCUMENT` at all.

Every measurement that "eliminated" a suspect had been taken against the wrong process. The daemon
under test was never in the room. With the setting fixed, the step passed on the first run and the
code is exactly `STALE_DOCUMENT` — verified by narrowing the assertion to that code alone.

The lesson is not "check the build" — that check was run, and passed, on a binary nobody executed.
It is that **an integration test must prove which process answered it**, not merely that an answer
arrived. `daemon-autostarted` in the extension's log is that proof here.

**Two real defects were found while chasing the wrong one**, and both are kept:

- the event bridge dropped document notifications silently in *seven* places, not five — the two
  nobody had counted were a `catch` that swallowed a failed send, and teardown. Each now names
  itself in the log, without carrying a URI or any file content;
- on JetBrains, writing the file on disk still does not invalidate a plan: the IDE holds its own
  copy and never saw the write. Worth knowing for anyone editing a bridged file in a second editor.

## Checking that nothing secret was written down

TASK.md §31 asks for logs that contain no tokens. The guards for that are in the code — a closed
catalogue of log events, no payloads, a `doctor` that repeats neither token nor endpoint — but the
check worth doing is the empirical one, against logs a real session produced:

```bash
grep -c "$(python3 -c 'import json;print(json.load(open("$IDE_BRIDGE_DISCOVERY_FILE"))["token"])')" \
  ~/.cache/ide-bridge/sandbox/*/*/log/idea.log
```

Measured on 2026-08-15 across **103 log files** — 8.3 MB of daemon log, 3.9 MB of IDE log, the VS
Code extension host, and every channel its window writes — searching for the two live tokens:
**zero occurrences**. Strings merely *shaped* like a token appear (894 in `idea.log`, 22 in VS Code's
renderer) and are the platforms' own identifiers, which is why the exact search is the one that
settles it.

## A second IDE, and a language engine this project had not tested

Everything above runs against IntelliJ, whose Java and Kotlin support is what the adapter was written
against. PyCharm is a different set of language engines behind the same platform APIs, which is the
only way to tell a plugin that uses the host IDE's engines from one that merely compiles against
them.

```bash
cd jetbrains-plugin
IDE_BRIDGE_SAMPLE_PROJECT=$PWD/../integrations/serena ./gradlew runPyCharm
```

Measured with **both IDEs connected to one daemon at once** — the first time multi-adapter routing has
been exercised:

```
adapters: ['IC-252.23892.409', 'PY-262.8665.369']
  ws_Uwvu…  jetbrains-plugin   file:///…/jetbrains-plugin
  ws_JuW_…  serena             file:///…/integrations/serena
```

Asking PyCharm's workspace for a Python file's symbols returns kinds from Python's own model —
`class`, `function`, `method`, `variable`, and **no `unknown`**. `diagnostics/getSnapshot` on the same
project refuses `CAPABILITY_UNAVAILABLE`, because that project was opened without an interpreter, so
its analyser cannot run — the refusal working on a third language engine rather than an empty answer.

## Serena demo

The JUNON integration composes onto Serena rather than editing it, so it is started by its own
command:

```bash
junon start-mcp-server --project <path> --transport stdio
```

`junon` composes and then hands over to Serena's own CLI unchanged; running `serena` directly still
gets plain Serena. Verify the tools arrived:

```bash
junon tools list | grep '^ \* `ide_'
```

That separation has a cost worth stating, because it was paid: an agent host configured to run
`serena` gets plain Serena and **no JUNON**, silently — same tool names, no dashboard published, and
the IDE panel with nothing to link to. Measured on this machine: the MCP server registered as
`serena` resolved to an unrelated pipx install of upstream Serena 1.5.3, in which `junon` is not even
importable, while fourteen registry entries from three days earlier all named dead processes. So the
panel now says *why* it has no link rather than hiding the section, and the host is configured with
the launcher's full path:

```bash
"$PWD/integrations/serena/.venv/bin/junon" start-mcp-server --project-from-cwd --transport stdio
```

Started this way, the launcher publishes `{"url": …, "pid": …, "project": "moneta"}` within seconds,
its dashboard answers `200` and is JUNON's page rather than Serena's, and a clean exit removes the
entry again.

Measured:

```
 * `ide_apply_fix`: Applies one of the IDE's quick fixes — or, by default, only says what it would do.
 * `ide_diagnostics`: The IDE's own inspections, with the fixes it offers for them.
 * `ide_find_symbol`: Searches the IDE's own symbol index, optionally narrowed by kind.
 * `ide_hierarchy`: Callers, callees, supertypes and subtypes, from the IDE's own hierarchy engines.
 * `ide_status`: Reports whether an IDE is connected, and what it has open.
 * `ide_symbols_overview`: Top-level symbols of a file, as the IDE's own engine reports them.
 * `ide_todos`: TODO markers as the IDE recognises them, not as a text search guesses at them.
```

### 1–2. Backend and workspace

`ide_status` answers both at once, and distinguishes the states that look alike:

```
An IDE is connected with 1 workspace(s) open:
  - jetbrains-plugin [ws_Ynan-0tKr8brFAV3oWmH4kRV] file:///…/jetbrains-plugin
    trust: "trusted"
    readiness: ready
```

**Readiness is reported here because this is the tool a caller reaches for when nothing works**, and
until 2026-08-15 it never asked. The states are not equally actionable, so the answer says which is
which: `indexing` refuses index-dependent routes retryably and waiting works; `degraded` means the
IDE is answering nothing at all — most often waiting on a dialog nobody has clicked — and retrying
alone may never help; `disconnected` means the adapter stopped serving that workspace and it must be
linked again.

With the daemon running but no IDE attached it says so instead of guessing:

> The IDE Bridge daemon is running, but reports no open workspace. Either no IDE is connected to it,
> or the connected IDE has no project open.

The workspace is then chosen automatically by matching Serena's active project against the roots the
IDE reports; a project the IDE does not have open is refused by name, listing what it does have.

### 3–4. Symbols and references

`ide_find_symbol` and `ide_symbols_overview`. A kind the protocol does not define is refused with
the list of valid kinds rather than searched for and found empty.

`ide_read_symbol` returns one declaration's source, cut to the range the IDE reports for it — so a
KDoc or an annotation block comes with the declaration, because that is what the IDE considers the
declaration to be. Measured, all four of its answers:

```
'declarations' matches 3 declarations: function in StructureViewSymbols.kt line 48;
  function in StructureViewSymbols.kt line 101; function in PsiSymbols.kt line 35.
  Name a file with relative_path, or use a more specific name.

declarations (function) lines 35-48 of PsiSymbols.kt        # narrowed to one file
No declaration named 'noSuchDeclarationAnywhere' was found.
ReadinessWatchdog (class) lines 3-52 of ReadinessWatchdog.kt # unique in the workspace
```

The refusal is the point: a name matching several declarations is never answered with one of them.
Following its advice used to loop, though — two of those three are overloads in one file, and naming
that file returned the same refusal with the same advice. It now says what actually works:

```
'declarations' matches 2 declarations: … line 48; … line 101. They are all in one file, so
  relative_path cannot separate them — read it around those lines with ide_read_document.
```

### 5. A rename, or a fix, where possible

`ide_apply_fix` with `confirm=false` reports the plan and writes nothing; with `confirm=true` the IDE
performs the edit. Measured end to end, with the file restored afterwards by hash.

### 6. When a capability is absent

This is the part worth demonstrating deliberately, because it is where most systems lie.

**A filter the IDE cannot honour.** Searching with `kinds: ["class"]` for a name whose matches the
IDE never classified returns them under `unclassified`, not silently dropped:

```
matched     : []
unclassified: 16 declaration(s)
note        : 16 declaration(s) matched 'Companion' but carry kind 'unknown' … listed under
              'unclassified' rather than dropped, because a filter that hides what it cannot judge
              reports an incomplete answer as a complete one.
```

**A project the IDE cannot analyse.** `ide_diagnostics` on a project with no source roots:

> The IDE refused: [CAPABILITY_UNAVAILABLE]. Either this IDE provides no diagnostics, or — far more
> often — the project is open without a module or SDK, so its analyser cannot run. Open it as a
> Gradle, Maven or equivalent project in the IDE and ask again.

Before this refusal existed the same situation answered zero problems with `truncated: true`,
forever — indistinguishable from a clean file, and a consumer polling for completion never stopped.

**An IDE that cannot answer in time.** A route that exceeds its deadline answers `TIMEOUT` with
`retryable: true`, and retrying is correct; treating it as a failure is not. What has *not* been
observed is a rename or a re-index producing it — see the note under step 11–12, where two
plausible-sounding versions of this sentence were written first and neither survived measurement.
What does produce it: an adapter whose session has just been closed, and an IDE blocked on a modal
dialog. In both cases `workspace/getStatus` keeps answering `ready`, because the daemon answers it
from the adapter's last announcement rather than by asking.
