# ADR-0002 — Document Revisions

## Status

Accepted — revision shape amended by [ADR-0020](0020-revisions-for-unopened-documents.md)
(2026-08-02). `editorVersion` is **optional**: it exists only while a document is open in an editor
buffer, and a file on disk simply has none. `contentHash` is the authoritative identity in both
cases, as this ADR already states below. Editor versions are compared only when both sides carry
one. Everything else below stands.

## Context

IDEBP enables an agent to read a document, prepare an edit, and later apply that edit. Between preparation and application, the document may change (user edits, formatter, other tool). Applying an edit to a stale document would corrupt the file or produce incorrect results.

The protocol must:

1. Distinguish in-memory (unsaved) content from on-disk content.
2. Detect when a document has changed since an operation was prepared.
3. Prevent stale operations from being applied.
4. Support multi-workspace scenarios where the same file path may exist in different workspaces.
5. Invalidate semantic caches when structural changes occur.

VS Code tracks document versions via an incrementing `editorVersion` (the `TextDocument.version` property). JetBrains does not have an equivalent simple version number but provides PSI modification events.

## Decision

Every document reference in IDEBP carries a **revision** containing three components:

```json
{
  "editorVersion": 27,
  "contentHash": "sha256:...",
  "workspaceEpoch": 148
}
```

### editorVersion

- An integer that increments on every in-memory content change.
- Maps directly to VS Code's `TextDocument.version`.
- For JetBrains: the adapter maintains its own incrementing counter, incremented on PSI/document change events.
- Reflects unsaved buffer content, not disk content.

### contentHash

- SHA-256 hash of the document's in-memory content (UTF-8 encoded).
- Provides a content-based identity independent of the version counter.
- Used as a secondary precondition check: even if `editorVersion` is spoofed or desynchronized, the hash must match.
- Stable: same content always produces the same hash.

### workspaceEpoch

- An integer that increments when the workspace's semantic caches may be invalidated.
- Incremented on: workspace root changes, large structural changes, adapter reconnection.
- Used to invalidate symbol handles and plans that depend on semantic state.
- When `workspaceEpoch` changes, all handles with `validUntilEpoch < currentEpoch` are invalid.

### Stale document handling

When an operation is attempted on a document whose revision does not match the current revision:

1. Return error `STALE_DOCUMENT` with the current revision in the error data.
2. The client can re-read the document and retry.

### Precondition structure

Edit plans carry preconditions:

```json
{
  "type": "documentRevision",
  "uri": "file:///project/src/service.ts",
  "editorVersion": 27,
  "contentHash": "sha256:..."
}
```

`workspace/applyPlan` checks all preconditions before applying. Any mismatch → `PRECONDITION_FAILED`.

### In-memory vs. saved

- The revision always reflects in-memory content.
- A separate `savedVersion` or `isDirty` flag may be included in document metadata but is not part of the revision precondition.
- The hash is computed from the buffer content, not the disk file.

## Consequences

- **Positive:** Stale documents are reliably detected via two independent mechanisms (version + hash).
- **Positive:** `workspaceEpoch` allows bulk invalidation of semantic state without tracking individual documents.
- **Positive:** VS Code's native `version` maps directly; JetBrains adapter can synthesize an equivalent.
- **Positive:** Content hash provides defense against version counter desynchronization between adapter and daemon.
- **Negative:** Computing SHA-256 on every document change has a cost. Mitigation: debounce, compute in background, only hash when needed (on prepare/apply, not on every keystroke).
- **Negative:** JetBrains adapter must maintain its own version counter, adding implementation complexity.
- **Negative:** Two components (version + hash) must agree; if they disagree, the operation is rejected. This is intentional (defense in depth).

## Alternatives Considered

### editorVersion only

- Pros: Simple, maps to VS Code.
- Cons: No content-based verification; if the adapter's version counter desynchronizes from the daemon's view, stale edits could pass. JetBrains has no native equivalent.
- Rejected: Insufficient safety for a protocol that modifies source code.

### Content hash only

- Pros: Content-based, no version counter needed.
- Cons: Must hash the entire document on every check. No fast "has anything changed" test. Cannot distinguish "changed then reverted" from "unchanged".
- Rejected: Missing the fast incremental check that `editorVersion` provides.

### Last-modified timestamp

- Pros: Simple.
- Cons: Filesystem timestamps have insufficient precision (second-level on some filesystems); do not reflect unsaved buffer content; not available in all IDE APIs uniformly.
- Rejected: Unreliable.

### ETag-style weak hash

- Pros: Faster than full hash.
- Cons: Weak hashes can collide; insufficient for source code integrity.
- Rejected: Safety over speed.
