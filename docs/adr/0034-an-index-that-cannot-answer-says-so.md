# ADR-0034 — An index that cannot answer says so

## Status

Accepted — 2026-08-10

## Context

`workspace/searchSymbols` reads the IDE's name index. On 2026-08-10, verifying the search fixes in a real
sandbox IDE, that index answered nothing for either open project — and it took an hour of measurement to
learn why, because the response could not say. Two different states produce the same empty list:

1. **The IDE is still building the index.** Transient. `DumbService.isDumb` reports it, and
   `IntelliJProjectSnapshot.indexState` already mapped it to `ReadinessModel.IndexState.DUMB` for the
   readiness route. The protocol has carried `INDEX_NOT_READY` — explicitly retriable — since Phase 1.
   The search route never used it.
2. **The project has no source root.** Not transient. A Gradle import that produced no modules, or a
   plain directory nobody marked, leaves files in a content root that no module marks as sources; the
   index is complete and holds nothing for them. Measured: the IDE's own Go-to-Symbol dialog found
   nothing there either, so the adapter was agreeing with the IDE rather than failing. Retrying never
   helps. Only the person in the IDE can fix it, by marking a directory as sources or finishing the
   import — and nothing told them.

An empty list said neither. It read as "no such symbol", which a consumer believes, and which is the one
thing that was certainly not known. `symbol/getHierarchy` had already met this shape and answered it, in
a comment this ADR is only generalising: *"A relation with no language-neutral engine behind it is
refused by name. The alternative — an empty result — would read as 'nothing found' and be believed."*

## Decision

### Indexing is a refusal, not an answer

`AdapterRouter.Backend.searchSymbols` returns a `SearchOutcome` — `Found(result)` or `IndexNotReady` —
mirroring the existing `HierarchyOutcome`. `IndexNotReady` becomes `INDEX_NOT_READY` on the wire, which
is retriable by contract, so a consumer knows to ask again instead of recording an absence. `null` still
means "not my workspace" and still becomes `WORKSPACE_NOT_FOUND`; the two refusals stay distinguishable.

### A project with no source root is answered, flagged, and reported to the human

- On the wire: `truncated: true`. The workspace holds matches the response cannot carry, which is what
  the flag means — even though none were seen. This is the same rule ADR-0032 applied to hits dropped
  for representability, and it needs nothing new on the wire.
- It is **not** refused with `INDEX_NOT_READY`: that code promises a retry will work, and here it never
  will. Using it would make a retriable code lie.
- In the IDE: a notification, at most once per project, saying what to do rather than what happened —
  mark a directory as Sources Root, or finish the project import. That is the hour this cost, given back.

### The warning arrives when the project is exposed, not when a search fails

Warning from the search route alone was the first shape, and trying it found the flaw: on 2026-08-11 a
project was opened, **linked automatically** — so exposed to any consumer — and nothing said it could not
be searched, because no consumer had tried yet. Linking is when a project becomes a promise; that is when
the warning belongs. It fires on linking *and* on searching, with one guard covering both, so a project
still says it once and not twice.

It is deferred to **smart mode** (`DumbService.runWhenSmart`) rather than checked as the link completes,
and that is load-bearing rather than cautious: measured on 2026-08-10, a Gradle project had no source root
at open and acquired one when its import finished — the same project answered nothing one day and
seventeen hits the next. Checking immediately would have warned about a state that was about to fix
itself, which is the fastest way to teach someone to ignore a warning.

`unlink` forgets what a project was warned about. The guard exists to avoid repeating on every search, not
to warn only once in a project's life: a project that is fixed, relinked and still broken must say so
again.

### The product names itself

The notification group is `Junon - IDE Bridge` and every title carries that prefix, so a balloon states
which product it came from before it states what it wants. The group id is also the name the user sees in
Settings → Notifications, which is where they silence it; the plugin carries the same name in the plugins
list.

### The plugin owns its switch; the IDE owns the system notification

Registering `<notificationGroup id="IDE Bridge">` is what places the group in the IDE's own
Settings → Appearance & Behavior → Notifications, where the user decides whether a balloon also becomes
an operating-system notification. The plugin does not force that: it is the IDE's setting for every
plugin, and overriding it would be deciding for the user.

What the plugin does own — whether it warns at all — is a checkbox in the `IDE Bridge` panel, persisted
application-wide through `PropertiesComponent`. The panel is where the consequence appears, so it is
where the control belongs; the panel also points at the IDE's setting rather than reproducing it, because
two controls over one setting means the user loses whichever disagreement follows.

### The transient case gets no balloon

Indexing finishes by itself. The wire reports it and the balloon does not, because a warning that
appears and resolves on its own teaches the reader to dismiss the ones that matter.

## Consequences

- A consumer searching during indexing now receives `INDEX_NOT_READY` where it previously received an
  empty, complete-looking result. That is a behaviour change on the wire, and the intended one.
- A consumer searching a project with no source root receives `truncated: true` with whatever was found,
  so "incomplete" is stated even when the list is empty. ADR-0031 already made empty-plus-truncated a
  legal combination for this route, which is what lets this be expressed without a schema change.
- The human is told once per project, with the fix, through a group they can silence — from the panel or
  from the IDE's notification settings.
- Three router-level tests pin the wire answers: an unbuilt index refuses with `INDEX_NOT_READY`, an
  unknown workspace still refuses with `WORKSPACE_NOT_FOUND`, and a found result — including
  empty-and-truncated — still travels as a result.
- `SearchOutcome` changes the `Backend` interface, so every implementation states which case it is in.
  The one stub in the router tests was updated; there is no other implementation.
- Still true, and now visible instead of inferred: a project whose files are in no source root cannot be
  searched. The adapter no longer presents that as an answer.
- Verified in a real IDE on 2026-08-11, and the experiment was arranged so its result could only mean one
  thing: after a restart that linked an unindexed project, **no search was issued**, so the balloon that
  appeared could only have come from linking. The wire half was measured in the same session — three
  queries over that project, each `hits=0 truncated=true`, while `document/getSymbols` on the same file
  returned `Widget → Companion`, since that route needs no index.
- The link-time trigger has no unit test: linking requires a live daemon, and the link tests deliberately
  point at one that does not exist so their result is not the machine's. It is covered by the live run
  above, which for this particular behaviour is the stronger evidence — a balloon is a thing a person sees.

## Alternatives considered

### Leave the empty result and document it

Rejected — it is the defect. A truthful-but-unlabelled empty answer is indistinguishable from a
factual one, and it cost an hour of a real session to tell apart, with the IDE running and both a
consumer and a maintainer looking at it.

### Use `truncated` for the indexing case too

Rejected. It conflates "more matches exist" with "the index is not built yet", and it loses the one thing
a consumer needs there: that retrying will work. `INDEX_NOT_READY` carries that; `truncated` does not.

### Refuse the no-source-root case with `INDEX_NOT_READY`

Rejected for the opposite reason: retrying will never help, so a retriable code would send a consumer
into a loop over a state only a human can change.

### Force a system notification from the plugin

Rejected. Whether a notification group reaches the operating system is the IDE's setting, per group, for
every plugin. A plugin that overrode it would be answering a question the user has already been asked.
