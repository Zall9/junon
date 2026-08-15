# ADR-0004 — Two-Phase Edits (Prepare / Apply)

## Status

Accepted — amended by [ADR-0007](0007-daemon-owned-plan-and-undo-identities.md) on 2026-08-01

## Context

IDEBP enables an agent to modify source code through IDE adapters. Direct application of edits is unsafe because:

1. The document may have changed between the decision to edit and the application.
2. The agent may need to preview changes before applying.
3. The IDE's semantic provider (refactoring engine) must validate the operation.
4. Operations must be undoable.
5. Operations must not be replayed (applied twice).
6. The agent and IDE may be in different processes; a crash between decision and application must not leave partial state.
7. Different IDEs have different refactoring APIs; the protocol must abstract this.

TASK.md §15 mandates that all semantic modifications use two phases: prepare → apply.

## Decision

All semantic modifications in IDEBP use a **two-phase prepare/apply model**.

### Phase 1: Prepare

Example: `refactor/prepareRename`

**Input:**
```json
{
  "workspaceId": "ws_42",
  "symbol": {
    "handle": { "id": "sym_123" }
  },
  "newName": "updateStream",
  "options": {
    "includeComments": false,
    "includeStrings": false
  }
}
```

**Output (Edit Plan):**
```json
{
  "planId": "plan_123",
  "adapterId": "adapter_vscode_1",
  "sessionId": "session_consumer_1",
  "workspaceId": "ws_42",
  "expiresAt": "2026-08-01T13:30:00Z",
  "operation": "rename",
  "guarantee": "semantic",
  "atomicity": "text-only",
  "preconditions": [
    {
      "type": "documentRevision",
      "uri": "file:///project/src/service.ts",
      "editorVersion": 27,
      "contentHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "workspaceEpoch": 4
    }
  ],
  "changes": [
    {
      "kind": "textEdit",
      "uri": "file:///project/src/service.ts",
      "editCount": 2
    }
  ],
  "warnings": []
}
```

The prepare phase:
- Validates the symbol handle (or relocates via locator — see ADR-0003).
- Invokes the IDE's semantic provider (VS Code `prepareRename` + `provideRenameEdits`; JetBrains rename refactoring).
- Collects all affected files and edits.
- Computes preconditions (document revisions for all affected documents).
- Returns a plan with: guarantee level, atomicity, affected files, edit count, warnings, expiration.

### Phase 2: Apply

`workspace/applyPlan`

**Before applying, the daemon checks:**
1. **Expiration:** `expiresAt` must not have passed.
2. **Session:** the plan belongs to the requesting session.
3. **Workspace:** the plan belongs to the requesting workspace.
4. **Preconditions:** all document revisions must match current state.
5. **Permissions:** workspace trust must allow writes.
6. **Revisions:** all content hashes must match.
7. **Reuse prevention:** the plan must not have been consumed.

If any check fails, return the appropriate error (`PLAN_EXPIRED`, `PLAN_NOT_FOUND`, `STALE_DOCUMENT`, `PRECONDITION_FAILED`, `PERMISSION_DENIED`).

**After applying:**
- Return modified documents (URI, new revision).
- Return before/after content hashes.
- Invalidate all handles associated with affected documents.
- Optionally retrieve post-edit diagnostics if requested.
- Return an `undoToken` when the IDE supports undo.

### Plan lifecycle

A plan must be:

1. **Bound to an adapter:** only the adapter that created the plan can apply it.
2. **Bound to two sessions internally:** the public plan belongs to the requesting consumer session,
   while its private adapter representation remains bound to the adapter session that created it
   (see ADR-0007).
3. **Bound to a workspace:** only the workspace that the plan targets can apply it.
4. **Non-reusable:** the plan is consumed before an apply is forwarded and cannot be reactivated
   after any outcome, including cancellation, timeout, disconnect, or a lost response (ADR-0007).
5. **Automatically expired:** `expiresAt` timestamp; also expired when `workspaceEpoch` advances.
6. **Explicitly discardable:** `workspace/discardPlan` allows the client to free resources.
7. **Invalidated on relevant changes:** when a document listed in preconditions changes, the plan is invalidated.

### Plan store

The daemon maintains an in-memory plan store for the MVP. The store interface supports:

- Expiration (time-based + epoch-based).
- Invalidation (document change triggers precondition re-check).
- Atomic consumption (only one `applyPlan` can consume a plan; concurrent attempts get `PLAN_NOT_FOUND` or `PLAN_EXPIRED`).
- Workspace-scoped invalidation for cleanup.
- Periodic cleanup (sweep expired plans).

The store interface is abstracted to allow future persistent storage.

### Atomicity

- `text-only` (MVP): the IDE applies all text edits as a single `WorkspaceEdit` (VS Code) or write command (JetBrains). If the IDE reports partial failure, return `PARTIAL_APPLY` with the documents that were modified.
- `semantic` atomicity (future): the IDE's refactoring engine guarantees semantic consistency (no broken imports, no syntax errors). Not all operations or IDEs support this; the guarantee level is declared per-capability.

### Fallback policy

**No silent fallback.** When an adapter refuses a semantic operation (capability unavailable, provider missing, guarantee cannot be met), the daemon returns `CAPABILITY_UNAVAILABLE`. It does **not** fall back to text replacement.

A fallback may be:
- Explicitly configured (client opts in).
- Announced to the consumer (guarantee level downgraded from `semantic` to `raw-text`).
- Accompanied by its guarantee level.

### Undo

- `workspace/undo` with an `undoToken` reverses the last applied plan when the IDE supports it.
- VS Code: uses `workspace.applyEdit` with inverse edits or the editor's undo stack.
- JetBrains: uses the refactoring undo framework or write command undo.
- Undo is best-effort; not all operations or IDE states support it.

## Consequences

- **Positive:** Stale documents are rejected before any modification, preventing corruption.
- **Positive:** The agent can preview changes (plan output) before applying, enabling human-in-the-loop workflows.
- **Positive:** Plan reuse is prevented, eliminating double-apply bugs.
- **Positive:** The plan store is abstracted, allowing future persistent or distributed storage.
- **Positive:** No silent fallback ensures the agent never unknowingly degrades from semantic to text editing.
- **Negative:** Two round-trips (prepare + apply) add latency. Acceptable for correctness.
- **Negative:** The plan store consumes memory; mitigation is expiration and cleanup.
- **Negative:** The daemon must synchronize plan access across concurrent requests (atomic consumption).
- **Negative:** Undo is best-effort; the agent must handle `CAPABILITY_UNAVAILABLE` for undo.

## Alternatives Considered

### Direct apply (single phase)

- Pros: Simpler, one round-trip.
- Cons: No preview, no precondition checking before the IDE commits changes, no plan reuse prevention, no expiration. If the document changed between decision and application, the edit is applied to stale content.
- Rejected: TASK.md §15 mandates two phases. Single-phase is unsafe for semantic operations.

### Optimistic apply with rollback

- Pros: One round-trip, rollback on failure.
- Cons: Requires reliable undo in all IDEs (not guaranteed); leaves the document in a transient state during rollback; cannot preview before applying.
- Rejected: Does not meet the preview requirement; rollback is not universally available.

### Plan without preconditions

- Pros: Simpler plan structure.
- Cons: Cannot detect stale documents; the edit could be applied to changed content.
- Rejected: Preconditions are essential for safety (see ADR-0002).

### Persistent plan storage (database)

- Pros: Plans survive daemon restart; can be reviewed later.
- Cons: Out of scope for MVP (TASK.md §29 defers durable plan persistence). Adds storage dependency, schema migration, and security concerns.
- Deferred: The store interface is abstracted; persistent storage can be added post-MVP.
