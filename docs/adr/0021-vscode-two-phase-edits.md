# ADR-0021 — VS Code two-phase edits, and the absence of undo

## Status

Accepted — 2026-08-02

## Context

`refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, and `workspace/undo` are
the first operations that modify the user's code. Three properties of the host API and of the
existing daemon shape the design.

**VS Code exposes no undo.** The extension API has no function to revert an applied
`WorkspaceEdit`. The only mechanism available is the built-in `undo` command, which operates on the
focused text editor — not on a multi-file workspace edit, and not necessarily on any document the
plan touched.

**Text-only workspace edits are atomic.** VS Code documents that "when applying a workspace edit
that consists only of text edits an 'all-or-nothing'-strategy is used". A rename produces only text
edits, so a `false` result means nothing was written.

**The daemon never checks content preconditions.** `consumePlan` validates plan ownership, expiry,
consumer session, workspace, and epoch. The revision hashes recorded in a plan are validated only
*after* the fact, against the result the adapter returns. Nothing in the daemon prevents an adapter
from applying a plan whose documents changed since preparation.

## Decision

### `workspace/undo` is declared unavailable

- The adapter registers `workspace/undo` as `support: "unavailable"` with a reason, returns no
  `undoToken` from `workspace/applyPlan`, and registers no handler for the method.
- Running the built-in `undo` command is rejected outright. It would act on whatever editor happens
  to be focused — possibly a document the plan never touched, possibly reverting the user's own
  manual edit — while reporting success. A wrong revert reported as a correct one is worse than an
  honest refusal.
- `undoToken` is optional in `modificationResult` and the capability model has an `unavailable`
  state, so the contract already expresses this. Acceptance criterion 9 is conditioned on the IDE
  supporting undo.

### The adapter verifies preconditions immediately before applying

- Every precondition's content hash is recompared against the document's current revision in the
  moment before `applyEdit` runs. A mismatch returns `STALE_DOCUMENT` with the current revision and
  writes nothing.
- A document that became unreadable — deleted or moved — returns `PRECONDITION_FAILED` rather than
  `STALE_DOCUMENT`, whose structured invariant requires a current revision that does not exist.
- This is not redundant with the daemon: the daemon's checks are about authorization and freshness
  of the plan, not about the content the plan was computed from.

### Plans are held by the adapter, bounded and one-shot

- The `WorkspaceEdit` itself never crosses the wire; the adapter stores it against its own plan id,
  which the daemon maps to a separate public id (ADR-0007).
- A plan is removed from the store *before* the edit runs, so a retry can never replay it.
- Plans are bound to the physical session and workspace epoch, expire after two minutes, are capped
  at 32 live plans, and are dropped when any document they cover changes — their preconditions
  cannot survive that.
- One plan is limited to 500 documents and 10,000 edits. A refactor beyond that is refused at
  prepare rather than attempted.

### Workspace trust is checked at both phases

- Both `refactor/prepareRename` and `workspace/applyPlan` require `workspace.trust === "trusted"`.
  Trust can be revoked between the two, and a prepared plan is not an authorization to write later.

### Applying saves, and says so in advance

- After a successful `applyEdit`, every modified document is saved.
- Hashes are computed **after** the save settles. Saving runs will-save participants such as
  format-on-save, which can change the content again; hashing before the save would report a state
  that never existed on disk.
- Because the adapter saves and offers no undo, applying is irreversible through IDE Bridge. Every
  prepared plan therefore carries a warning saying exactly that, so a consumer sees it before
  deciding to apply.

### Scope and bounds

- Every URI in the edit must lie inside a registered root, checked before any precondition is
  computed. Otherwise `PERMISSION_DENIED`.
- `prepareRename` is called first: it is the provider's own answer to whether the position may be
  renamed at all. A refusal is `PRECONDITION_FAILED`, not `PROVIDER_FAILED` — nothing malfunctioned.
- `includePostApplyDiagnostics` is honoured by returning the diagnostics snapshot for the modified
  documents. Language services may not have re-analysed yet, so the result reflects the moment it
  was taken and nothing more.
- `PARTIAL_APPLY` is never emitted: text-only edits are all-or-nothing, so there is no partial state
  to report.

## Consequences

- Multi-file rename works, with one precondition per affected file, including files no editor has
  open (ADR-0020 made that expressible).
- An applied rename is written to disk immediately. The user's usual escape hatch — closing without
  saving — is gone, and so is undo. The plan warning is the only prior notice, which is why it is
  mandatory rather than advisory.
- A user editing any covered document between prepare and apply invalidates the plan. For a
  wide-reaching rename in an actively edited workspace, that window is genuinely short.

## Alternatives considered

### Execute the built-in `undo` command for `workspace/undo`

Rejected. It targets the focused editor rather than the applied edit, so it may revert an unrelated
document or a manual change while reporting that the plan was undone.

### Leave modified documents dirty instead of saving

Considered and explicitly overridden by the project owner in favour of saving, so that an applied
rename exists on disk for non-interactive consumers. The cost — no close-without-saving escape and
no undo — is recorded above and surfaced in the plan warning.

### Rely on the daemon to validate preconditions

Rejected because it does not: the daemon validates the result after the edit has already been
written. By then the wrong content has been modified.

### Keep the plan in the store until the edit succeeds

Rejected. A crash or a concurrent retry between the two points could apply the same plan twice.
Removing it first makes replay impossible at the cost of a failed apply consuming the plan, which is
the safer direction.
