# ADR-0038: The party that applies a plan is the party that checks it

- Status: accepted
- Date: 2026-08-14
- Related: [ADR-0033](0033-linking-projects-is-a-choice-with-a-session-each.md), [ADR-0037](0037-an-integration-test-must-name-the-process-that-answered.md)

## Context

TASK.md §30 step 12 asks for a prepared plan to be refused after its document changes. On VS Code
this passes. On JetBrains, driving it against a real IDE exposed four defects in the same path, none
of which any suite had caught — because every existing rename test renamed within a single file, and
the plugin's own sources happen to contain no offered quick fixes to make a second edit with.

## Measurement

Each was found by driving the product, and each was invisible until the previous one was fixed:

1. **`refactor/prepareRename` declared one precondition — the declaration — while declaring changes
   for every file.** The daemon refuses a change with no precondition on its document, correctly: it
   would write to a file whose state nobody checked. Every cross-file rename was therefore refused.
2. **`workspace/applyPlan` reported one modified document.** The daemon requires a result to account
   for every document the plan named. The same failure, one phase later — after the consumer had
   committed to the plan.
3. **`RenamePlanRegistry.claim` checked session, workspace, epoch and expiry, and never the
   documents.** So a plan prepared against text that had since changed was **applied**: edits
   computed for offsets that had moved were written to disk, and only then did the daemon reject the
   response, because the reported before-hash disagreed with the plan. The refusal that exists to
   prevent the damage arrived after the damage. This is exactly the failure step 12 is about, and it
   was live.
4. **The check added for (3) read PSI, which lags the editor's document until it is committed.** Its
   first version passed on text the user had already changed — the very state it exists to detect.
   Found by a test that made the edit and watched the stale plan apply anyway.

Two further facts shaped the fix. A contract violation makes the daemon **close the adapter's
session** (1008), so each of these adapter defects presented as *the whole bridge dying*, not as one
refused refactoring. And the close reason — the only channel that reaches an adapter author — read
`…rejected during prepare transformation: PROVIDER_FAILED`, because the plan store threw seven bare
`PROVIDER_FAILED`s that named the outcome and never the rule. Six conditions could have produced it.

## Decision

**An adapter checks a plan's preconditions before it writes.** `applyPlan` compares every
precondition's `contentHash` against the document's current text and refuses `PRECONDITION_FAILED`
without touching anything. The daemon's own check stays: it is a second line, not the first.

**It reads what the user can see, and what is actually on disk.** Uncommitted documents are committed
before hashing, so PSI and the editor's buffer agree — every route in this adapter reads PSI text,
and none of them may read it stale. The files a plan names are also refreshed from the file system
first, because an edit made outside the IDE reaches it on no reliable schedule: measured at ninety
seconds in one run and forty-five in another. Only files the editor holds *unmodified* are refreshed;
refreshing a modified one raises IntelliJ's "reload from disk?" dialog, and a dialog nobody answers
blocks the IDE entirely (ADR-0039).

**A plan guards every document it changes**, and an apply reports every document the plan named.

**An adapter announces the documents it changes.** `document/changed` is sent for each document an
applied plan or an undo touched — TASK.md §12 requires a document change to invalidate the plans
concerned, and the daemon's store cannot do that for edits nobody told it about. Scoped to the edits
this adapter performs; text the user types is not forwarded, which §12 permits for the MVP and which
`DEMO.md` states rather than leaving to be discovered.

**Every refusal in the plan store names its rule**, not merely its code, and the compound checks are
split so that "one of three things" is never the answer.

## Consequences

Step 12 passes on JetBrains: a cross-file rename prepares and applies, and the stale plan is refused
`STALE_DOCUMENT`, non-retryable, carrying the revision to prepare against — by the daemon, which
never forwards the request. With the adapter's check but without the notification the same scenario
answered `PRECONDITION_FAILED` from the adapter: also correct, and the difference is exactly what a
consumer can act on. The file is untouched and the session intact in both cases.

`RenameAcrossFilesTest` pins all three rules against a real project, and each is proved by mutation.
The fixture renames across two files deliberately: a single-file fixture is what let four defects
live in a tested path.

The lesson is narrower than "test more". The daemon's checks were all correct and all fired — the
adapter simply relied on them, and a check that runs *after* the write is not a check. The party
that performs an irreversible action is the party that must verify it first.
