# ADR-0019 — Diagnostics snapshot, events, bounds, and redaction

## Status

Accepted — 2026-08-02. Snapshot scope amended the same day by
[ADR-0020](0020-revisions-for-unopened-documents.md): `editorVersion` became optional, so a closed
document now has an expressible revision read from disk. The snapshot therefore covers **all**
in-workspace documents with diagnostics, not just open ones, and `truncated` reports only real
ceilings. `diagnostics/changed` remains limited to open documents, since that event is driven by
editor state rather than by content. Everything else below stands.

## Context

`diagnostics/getSnapshot` and the `diagnostics/changed` notification are the last read-only surface
of the VS Code adapter. Three properties of the contract and the host API shape the design.

Every snapshot entry carries a full `documentReference`, which requires a `revision` with an
`editorVersion`. But `vscode.languages.getDiagnostics()` reports diagnostics for **all** resources
the language services know about, including files the editor has never opened — and `editorVersion`
is an editor concept that does not exist for them. Reading the file through `workspace.fs` would
yield a content hash but still no editor version. The same constraint applies to
`diagnostics/changed`, whose params also require a revision.

The daemon validated the `diagnostics/changed` notification for workspace ownership only. Unlike
every `document/*` event, it did not check that the named URI lay inside a registered root, so an
adapter could have caused any path — `file:///etc/passwd` — to be broadcast to every consumer.

The snapshot response had `documents` and `capturedAt` but no way to report that it was partial,
and neither the document count, the per-document diagnostic count, nor the message length was
bounded. Diagnostic text is also the one payload in the protocol that is deliberately rich, which
makes its interaction with logging worth stating explicitly rather than assuming.

## Decision

### Snapshot scope follows what the editor actually holds

- Without `documentUris`, the snapshot covers only documents the editor currently has open. Those
  are exactly the documents with a truthful `editorVersion`.
- If VS Code reports diagnostics for in-workspace resources that are not open, `truncated` is set.
  The consumer learns the answer is partial instead of reading a short list as complete.
- With `documentUris`, the adapter resolves each requested document through the normal document
  route — opening it if necessary, exactly as `document/read` does. The caller named the document,
  so it accepts that cost.
- The adapter never opens documents merely to widen an unfiltered snapshot. Opening every diagnosed
  file would load hundreds of buffers and emit a `document/opened` and later `document/closed` for
  each, making a read massively observable (the principle established in ADR-0017).
- Resources outside every registered root are ignored and do **not** set `truncated`: scope is not
  incompleteness, consistent with ADR-0017 and ADR-0018.
- An explicitly requested URI outside the workspace fails the whole request with
  `PERMISSION_DENIED` rather than returning fewer documents than were asked for.

### `diagnostics/changed` covers open documents only

- The notification requires a revision, so it is emitted only for documents the editor holds open.
  A diagnostics change on a closed file is silently not announced — a real limitation, stated here
  rather than papered over with a fabricated revision.
- Events are debounced per URI on the same 75 ms window as document changes, because language
  services republish diagnostics repeatedly while typing, and one event may name many resources.

### Bounds without altering data

- A snapshot carries at most `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS` (500) documents and
  `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` (1000) diagnostics per document, both shared through the
  protocol package so the daemon can reject a result that exceeds them.
- `message` is deliberately **not** bounded by the schema. TypeScript and Rust emit legitimately
  long messages for deeply nested types, and clipping one would silently misreport what the
  language service said. Payload size is instead controlled by dropping whole documents until the
  response fits the frame ceiling, with `truncated` set — the same shape as the search result fit.
- A diagnostic VS Code reports in a form IDEBP cannot represent (no range, no message) is skipped
  and sets `truncated`. One malformed diagnostic from one extension must not hide every other
  diagnostic in the workspace.
- An unknown numeric severity maps to `error`, matching VS Code's own default for an unset
  severity. Downgrading an unrecognised value to `hint` would understate a real problem.
- `relatedInformation` is capped at 32 entries, and entries pointing outside the workspace are
  dropped: a diagnostic must not become a channel for reporting external paths.

### Redaction

- Diagnostic text travels on the wire because it is the payload consumers request. It never reaches
  a log: the daemon logger has a closed event catalogue with no payload fields (ADR-0011), and the
  adapter's diagnostics modules take no logger at all.
- This is asserted end to end, not assumed: a routed snapshot carrying a secret-shaped message and
  source is checked to reach the consumer intact while appearing in no log line, along with the
  document URI.

### Daemon validation

- `diagnostics/changed` now requires the named URI to lie inside a registered root and the
  announced `workspaceEpoch` to match the workspace's current epoch.
- A routed snapshot is validated per entry: document count within the ceiling, per-document
  diagnostic count within the ceiling, no document reported twice, each document belonging to the
  workspace and inside a root, and every `relatedInformation` URI inside a root.
- A violation returns `PROVIDER_FAILED` to the consumer and closes the adapter session with a
  policy violation.

## Consequences

- An unfiltered snapshot on a typical project returns the handful of open documents, not the whole
  project's error list. Consumers wanting more must name the documents, which is explicit and
  bounded. `truncated` makes the difference visible rather than surprising.
- A consumer cannot learn about a compile error in a file nobody has opened without asking for that
  file by URI. This is the direct cost of requiring a truthful revision on every entry, and it is
  the trade the protocol's own contract forces.
- Diagnostics for closed documents changing produce no event, so a consumer polling
  `diagnostics/getSnapshot` sees changes that the event stream never announced.

## Alternatives considered

### Open every diagnosed document to capture its revision

Rejected. Hundreds of buffers loaded into the extension host, and an open/close notification pair
emitted per document, turning a read into a large observable mutation of editor state.

### Fabricate `editorVersion: 0` for closed documents

Rejected. `editorVersion` has a defined meaning (ADR-0002); zero is not "unknown", it is a claim
about the editor's state that would be false.

### Bound `message` in the schema and clip longer text

Rejected. Clipping alters what the language service reported, and long messages are legitimate.
Bounding counts and fitting by whole documents achieves the same size control without editing data.

### Fail the snapshot when one diagnostic is malformed

Rejected. A single misbehaving extension would erase the entire workspace's diagnostics.
