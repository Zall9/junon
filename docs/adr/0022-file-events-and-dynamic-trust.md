# ADR-0022 — Rename/delete events, deleted-document identity, and dynamic workspace trust

## Status

Accepted — 2026-08-02

Amends ADR-0002 indirectly through the `document/deleted` params change described below.

## Context

Three separate problems had to be resolved to close the event surface of the VS Code adapter.

**`document/deleted` contradicted itself.** Its params required a full `documentReference`, which
requires a `revision` with a `contentHash` — of a file that no longer exists. There is no content to
hash and no editor buffer to read. The notification could not be emitted truthfully for the very
event it names. This is the same class of defect ADR-0020 fixed for unopened documents, in a more
acute form: there is no on-disk fallback either.

**VS Code file events are narrower than they appear.** `onDidRenameFiles` and `onDidDeleteFiles`
are documented to fire for user gestures in the explorer and for `workspace.applyEdit`, but
explicitly **not** when files change on disk from another application or through the
`workspace.fs` API. A second documented note: renaming or deleting a folder with children fires
exactly one event, naming the folder.

**Trust is monotonic and had no way to be announced.** VS Code exposes `workspace.isTrusted` and
`onDidGrantWorkspaceTrust` — a grant event only. Trust cannot be revoked without a window reload,
which restarts the extension host and produces a fresh registration anyway. But the daemon caches
`workspace.trust` and gates `workspace/applyPlan` and `workspace/undo` on it, so a grant that never
reached the daemon would leave writes refused indefinitely. No existing notification could carry
it: `openWorkspace` rejects a re-announcement with `PRECONDITION_FAILED`, and `workspace/closed`
followed by `workspace/opened` would purge plans and drop handles that trust has not invalidated.

## Decision

### A deleted document carries identity, not content

- `document/deleted` params become `workspaceId` and `uri`. No revision, no `isDirty`, no
  `languageId` — none of them exist for a file that is gone.
- The daemon validates the notification by URI containment alone and invalidates plans for that
  document. A deletion naming a path outside every registered root closes the adapter session.
- A fixture asserts that a deletion carrying a revision is rejected, so the contradiction cannot
  return.

### `workspace/trustChanged`

- A new adapter-outbound notification carrying `workspaceId`, `adapterId`, and `trust`.
- The daemon updates that one field on the workspace record. Trust changing invalidates nothing
  else: roots, epoch, documents, handles, and plans are all unaffected, so nothing else is touched.
- The daemon verifies adapter ownership of the named workspace. An adapter announcing trust for a
  workspace it does not own is a policy violation and loses its session.
- `workspaceTrust` was extracted into a named schema definition shared by the `workspace` object and
  this notification, so the two cannot drift.
- Rejected alternatives: forcing a re-registration would drop a healthy connection, bump the epoch,
  and invalidate every handle to convey a boolean; `workspace/closed` + `workspace/opened` would
  make the workspace appear to vanish and purge state that remains valid.

### Rename and delete events are emitted only for what the editor can observe

- A gesture naming a document produces one event for it. A gesture naming a **folder** is projected
  onto the documents the editor currently holds open beneath that path — the only children the
  adapter can identify truthfully. Closed children of a renamed or deleted folder produce no event.
- Files changed, renamed, or deleted outside the editor produce no event at all, because VS Code
  emits none. This is stated rather than worked around: a filesystem watcher observes creates,
  changes, and deletes but cannot distinguish a rename from a delete-plus-create, and synthesising
  one would invent a semantic relationship the adapter did not observe.
- One gesture may name many files; the projection is bounded.

### External changes invalidate, they do not fabricate events

- A `createFileSystemWatcher("**/*")` invalidates symbol handles and prepared plans for any URI that
  changes on disk, including changes VS Code emits no document event for.
- It never emits a protocol notification. Its only job is to stop the adapter vouching for state
  that has already moved — closing the gap ADR-0017 recorded, where a closed file changed by an
  external tool left handles live.

## Consequences

- A consumer learns about deletions and renames it can act on, and is never handed a deleted
  document's fabricated revision.
- Granting trust mid-session immediately unblocks writes, with no reconnection and no loss of
  handles or plans.
- A consumer watching only the event stream will miss renames and deletions performed outside the
  editor, and closed children of folder gestures. Handles and plans for those paths are still
  invalidated, so nothing stale is acted upon — the consumer simply learns by a failed or refused
  operation rather than by an event.
- Trust can only widen within a session. Revocation arrives as a full extension-host restart, which
  re-registers from scratch.

## Alternatives considered

### Keep a `documentReference` in `document/deleted` and report the last known revision

Rejected. It would require capturing content in `onWillDeleteFiles` for every file, would be
impossible for closed files, and would describe a document that no longer exists as though it did.

### Derive rename events from a filesystem watcher

Rejected. A watcher reports a rename as an unrelated delete and create. Pairing them by timing or
content would be a guess presented as a semantic rename.

### Enumerate a renamed folder's children from disk

Rejected for deletions, where the children are already gone, and rejected for renames for symmetry
and cost: a large folder rename would produce an unbounded burst of events describing documents no
consumer asked about.
