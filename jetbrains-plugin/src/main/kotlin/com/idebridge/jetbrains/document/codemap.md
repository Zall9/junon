# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/document/

## Responsibility

Builds IDEBP `DocumentContent` and `Revision` from a workspace, a URI, and a content source. Enforces workspace containment and root matching, computes the authoritative SHA-256 content hash, attaches an adapter-maintained editor version only when the content came from an editor buffer, and reports dirty state truthfully. One file: `DocumentModel` (the mapper) plus `EditorVersionRegistry` (per-document counter).

## Design Patterns

- **Sealed source (discriminated union)** — `Source` (`DocumentModel.kt:23-29`) is `Buffer(text, isDirty)` or `Disk(text)`. The `editorVersion` and `isDirty` fields are derived from which variant, so disk content cannot accidentally claim a version or dirtiness.
- **Authoritative content hash (ADR-0002, ADR-0020)** — `contentHash` (SHA-256) is the identity of content; `editorVersion` is secondary metadata, not a precondition basis. Pre-conditions rest on the hash.
- **Adapter-maintained version counter (ADR-0002)** — `EditorVersionRegistry` counts changes itself because IntelliJ's modification stamp is a large, non-monotonic long unsuited to the protocol's `integer` field (`DocumentModel.kt:98-107`).
- **Fails closed on containment** — uses `WorkspaceUri.isWithinRoot` from `workspace/`; refuses `OUTSIDE_WORKSPACE` or `NO_MATCHING_ROOT` rather than reading anyway.
- **No path conversion** — URIs are never converted to local filesystem paths; `logicalPath` is for display only and is never used for filesystem access (`DocumentModel.kt:82-87`).

## Key Types

### `DocumentModel` (`DocumentModel.kt:21-95`)
The document reader.
- `Source` (sealed, `:23-29`) — `Buffer(text: String, isDirty: Boolean)` / `Disk(text: String)`.
- `Outcome` (sealed, `:31-37`) — `Ready(content: DocumentContent)` / `Refused(reason: Refusal)`.
  - `Refusal` (enum, `:34`) — `OUTSIDE_WORKSPACE` / `NO_MATCHING_ROOT`.
- Constructor takes an `EditorVersionRegistry` (default-constructed), so tests can inject a counter.

### `EditorVersionRegistry` (`DocumentModel.kt:108-124`)
Per-document editor versions.
- `versions: ConcurrentHashMap<String, AtomicInteger>` (`:109`) — keyed by URI.
- `current(uri): Int` (`:111`) — returns current version, 0 if unseen.
- `recordChange(uri): Int` (`:114-115`) — increments on every in-memory change; returns the new version.
- `forget(uri)` / `clear()` (`:117-123`) — cleanup on close / reset.

## Key Functions

- `read(workspace, uri, source, languageId?): Outcome` (`DocumentModel.kt:39-80`) — Finds the containing root via `WorkspaceUri.isWithinRoot`; refuses if none. Computes `relativePath`. Builds `Revision` (editorVersion only for Buffer, contentHash always, workspaceEpoch from workspace). Returns `DocumentContent` with `DocumentReference`, `text`, UTF16 encoding, `isDirty` only for Buffer.
- `relativePath(root, uri): String?` (`:82-87`) — Path of `uri` relative to its root, for display. Returns null if `uri` doesn't start with the root prefix (after trimEnd('/')).
- `hash(text): String` (`:90-93`) — `"sha256:"` + hex digest of UTF-8 bytes. Static, in companion.

## Data & Control Flow

```
Workspace (protocol DTO, with roots + epoch)
   │
URI + Source(Buffer|Disk)
   │  WorkspaceUri.isWithinRoot(uri, root.uri)   ──► containing root (or Refused: OUTSIDE_WORKSPACE)
   │  relativePath(root, uri)                    ──► logicalPath (or Refused: NO_MATCHING_ROOT)
   ▼
Revision
   ├─ editorVersion  = Buffer → EditorVersionRegistry.current(uri);  Disk → null  (ADR-0020)
   ├─ contentHash    = sha256(text)              (authoritative)
   └─ workspaceEpoch = workspace.workspaceEpoch
   ▼
DocumentContent
   ├─ document: DocumentReference (workspaceId, rootId, uri, logicalPath, revision, UTF16, languageId?, isDirty)
   └─ text
```

`EditorVersionRegistry.recordChange(uri)` is called by the document-change listener (Phase 3+) on every in-memory edit; `forget(uri)` on document close. Counters reset when the plugin restarts — safe because handles/plans are session- and epoch-bound and the hash, not the version, is what a precondition rests on (`DocumentModel.kt:101-106`).

## Integration Points

- **Consumed by:**
  - The `document/read` and `document/getRevision` handlers (Phase 4 document services) call `read()`.
  - Anything that needs a `Revision` precondition for prepare/apply (two-phase edits) consumes the `Revision` produced here.
- **Depends on:**
  - `com.idebridge.jetbrains.protocol.*` — `DocumentContent`, `DocumentReference`, `Revision`, `PositionEncoding`, `Workspace`, `WorkspaceRoot`.
  - `com.idebridge.jetbrains.workspace.WorkspaceUri` — containment check (`DocumentModel.kt:9,45`).
  - JDK (`java.security.MessageDigest`, `java.util.concurrent.ConcurrentHashMap`, `java.util.concurrent.atomic.AtomicInteger`).
- **External boundaries:**
  - `positionEncoding = PositionEncoding.UTF16` always (`DocumentModel.kt:72`).
  - `contentHash` format: `sha256:<hex>` on the wire.
  - No file I/O here — callers supply `Source` text; this module never opens a file.

## Common Gotchas

- **Disk content has no editorVersion.** `editorVersion` is `null` for `Source.Disk`, not 0 or a placeholder (ADR-0020). Omission is the truthful signal; a placeholder would let a precondition match disk against buffer (`DocumentModel.kt:57-60`).
- **`contentHash` is authoritative.** It is what a revision precondition rests on. `editorVersion` is secondary and adapter-maintained; do not treat it as a content identity (`DocumentModel.kt:17-19, 101-106`).
- **`isDirty` is only true for Buffer.** `source is Source.Buffer && source.isDirty` (`DocumentModel.kt:75`). Disk content is by definition what was last saved — never dirty.
- **Version counter resets on plugin restart.** This is safe by design: handles/plans are session- and epoch-bound, and the hash (not the version) is the precondition basis (`DocumentModel.kt:101-106`). Do not persist versions.
- **IntelliJ's modification stamp is not used.** It is a large, non-monotonic long unsuited to the protocol's `integer`; the plugin counts changes itself (`DocumentModel.kt:98-107`).
- **`relativePath` is display-only.** It is never used for filesystem access (`DocumentModel.kt:82-87`). URI is what travels on the wire and what containment checks.
- **Refusals fail closed.** `OUTSIDE_WORKSPACE` and `NO_MATCHING_ROOT` return a `Refused` outcome rather than reading anyway — the daemon would reject the result as a policy violation (`DocumentModel.kt:45-48`).
- **No file I/O in this module.** Callers supply `Source` (already-read text). This keeps the mapper pure and testable.
