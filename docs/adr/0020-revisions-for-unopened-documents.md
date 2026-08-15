# ADR-0020 — Revisions for documents no editor has opened

## Status

Accepted — 2026-08-02

Amends ADR-0002 (revision shape). Amends the snapshot scope decision in ADR-0019.

## Context

`revision` required `editorVersion`, which ADR-0002 defines as "an integer that increments on every
in-memory content change", mapping to VS Code's `TextDocument.version` and reflecting "unsaved
buffer content, not disk content". It is, by construction, a property of an open editor buffer.

A large share of the operations IDEBP exists for concern files that are **not** open: a workspace
symbol search spans the project, `symbol/getReferences` returns hits across files nobody has
opened, `vscode.languages.getDiagnostics()` reports every resource the language services know
about, and a multi-file rename overwhelmingly touches closed files. The protocol could not describe
any of them, because every document reference demanded a number that does not exist for a file on
disk.

Each increment so far absorbed this as a local limitation: search handles carry no verified
revision (ADR-0017), and the diagnostics snapshot was scoped to open documents (ADR-0019). The next
increment cannot: `refactor/prepareRename` must emit one precondition per affected file, so
"multi-file rename works" — Phase 3 acceptance criterion 3 — is unreachable while closed files have
no expressible revision.

Obtaining a version by opening the file on demand does not work either, and not merely for cost
reasons. VS Code documents that for `openTextDocument` "the lifecycle of the returned document is
owned by the editor and not by the extension. That means an `onDidCloseTextDocument`-event can
occur at any time after opening it." A version acquired that way describes a buffer the editor may
discard during the prepare→apply window — precisely the interval in which the precondition must
hold.

## Decision

### `editorVersion` becomes optional

- `revision` and `documentRevisionPrecondition` require `contentHash` and `workspaceEpoch`.
  `editorVersion` is present **only** when the document is open in an editor buffer.
- Its absence has one meaning: the content is the file on disk, which has no editor version. It is
  not "unknown" and never a placeholder value.
- `contentHash` is the authoritative identity in both cases. ADR-0002 already said so — the hash is
  what must match "even if `editorVersion` is spoofed or desynchronized" — so this change promotes
  the check that already carried the guarantee and drops the one that could not exist.

### Comparison rule

- An editor version is compared only when **both** sides carry one. The daemon's apply check still
  requires the version to have strictly advanced in that case, which is what proves an edit landed
  in a live buffer.
- When either side lacks one, the content hashes decide: the precondition hash must equal the
  before-hash, the result hash must equal the after-hash, and before must differ from after. Those
  checks were already present and are unchanged.
- Comparing an absent version against a present one is never treated as a mismatch. A file may be
  opened or closed between prepare and apply; the content is what matters, and a content change
  fails the hash check regardless.

### Reading disk content

- The adapter reads unopened files through `workspace.fs.readFile`, which creates no `TextDocument`
  and therefore emits no open or close event. Nothing about a read is externally observable.
- A disk-backed reference reports `isDirty: false` — disk content is by definition what was last
  saved — and omits `languageId`, which is not knowable without opening the document.

### Consequences for earlier decisions

- **ADR-0019 is amended.** The diagnostics snapshot no longer restricts itself to open documents.
  Closed documents are included with a disk revision, so `truncated` now reports only real
  ceilings, and `diagnostics/changed` is still emitted only for open documents because that event
  is driven by editor state.
- **ADR-0017 is unaffected.** Search handles still carry no verified revision, for the separate
  reason stated there: the provider ran over its own snapshots of many documents, so a revision
  captured afterwards would prove nothing about the ranges it returned. That is a coherence
  argument, not an expressibility one.

## Consequences

- Multi-file rename becomes expressible: every affected file, open or closed, gets a precondition.
- A diagnostics snapshot covers the whole workspace without opening anything.
- A precondition on a closed file is weaker than on an open one, in exactly the way reality is
  weaker: content-based rather than buffer-based. It still detects every content change.
- Consumers must treat `editorVersion` as optional. Reading it without a presence check is now a
  type error in TypeScript, which is the intended forcing function.

## Alternatives considered

### Open documents on demand so everything has an editor version

Rejected. The editor may close such a document at any time (documented behaviour), so the number
does not survive the window it would be used for. It also loads every touched file into the
extension host and emits an open/close event pair per file, turning reads into observable mutations
of editor state.

### A discriminated union: `{kind: "editor", …}` versus `{kind: "disk", …}`

Rejected as more change for the same guarantee. It would alter the shape of every message carrying
a document and force a branch at every read site, where an optional field already expresses the
distinction unambiguously and lets absent-versus-present comparisons fall out naturally.

### An adapter-maintained counter for closed files

Rejected. ADR-0002 permits this for JetBrains, where it tracks real PSI modification events. For a
closed file there is no event to count: the number would describe nothing observable, would not
survive a restart or reconnection, and would present itself as a strong precondition while being a
fabrication.
