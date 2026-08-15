# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/symbol/

## Responsibility

Manages opaque, session-bound symbol handles, the controlled relocation of stale ones, language-specific kind classification, and the conversion of PSI declaration trees into IDEBP `Symbol` DTOs. Produces protocol `Symbol` trees from adapter-side drafts, keeps two namespaces (document vs. transient), bounds memory with FIFO eviction, and — when a handle no longer resolves — matches the durable `SymbolLocator` against the current symbol tree to recover a reference or fail closed. Four files: `SymbolHandleRegistry` (generic over the anchor `A`, thread-safe, two-namespace bookkeeping), `SymbolRelocation` (pure matching, no platform types), `SymbolKindMapper` (extension point for language-specific kind classification), and `SymbolMapping` (PSI-to-Draft tree conversion, locator creation, fingerprinting).

## Design Patterns

- **Generic over anchor (dependency inversion)** — `SymbolHandleRegistry<A>` (`SymbolHandleRegistry.kt:28`) keeps all bookkeeping testable without the platform; the JetBrains adapter supplies `A = SmartPsiElementPointer` at runtime, which makes a handle resolvable in O(1) after PSI rebuild.
- **Two namespaces (ADR-0017)** — `DOCUMENT` (atomic replace of a document's symbol tree) vs. `TRANSIENT` (bounded FIFO generations for search hits / point resolutions). Producing transient handles never revokes document handles (`SymbolHandleRegistry.kt:22-27, 87-144`).
- **FIFO eviction, document-protected** — capacity pressure evicts the oldest transient generation first; document handles are never evicted to make room (`SymbolHandleRegistry.kt:166-175`).
- **Session/epoch binding** — every handle carries `adapterId`, `sessionId`, `validUntilEpoch`; `resolve()` checks all three (`SymbolHandleRegistry.kt:78-85`). A handle from another session or a stale epoch returns null.
- **Controlled relocation (ADR-0003, ADR-0018)** — when a handle is stale, the locator is the durable identity. `SymbolRelocation` matches semantic fields (name, kind, containerName) inside the same document; selection range is a tie-breaker only; fingerprint is never matched (`SymbolRelocation.kt:9-13`).
- **Fails closed** — no match → `NotFound`; several indistinguishable matches → `Ambiguous` with every candidate (capped). Nothing is guessed (`SymbolRelocation.kt:19-20`).
- **Shared test vectors (ADR-0025)** — relocation rules are checked against `packages/protocol/fixtures/vectors/symbol-relocation-vectors.json`, shared with the VS Code adapter, so the same protocol cannot answer differently per IDE.
- **Extension point for kind classification** — `SymbolKindMapper` is an IntelliJ extension point (`EP_NAME = "com.idebridge.jetbrains.symbolKindMapper"`), so what the adapter can classify is decided by the IDE it was installed into. CLion contributes C++ knowledge, PhpStorm PHP knowledge; neither has to be anticipated here (`SymbolKindMapper.kt:7-19, 26-27`).
- **Refuse-not-truncate for structural bounds** — `SymbolMapping.mapDocument` throws (`require`) when depth > 64, count ≥ 5_000, or a cycle is detected (identity set). A result that exceeded the bounds would be indistinguishable from a document that genuinely has that few symbols (`SymbolMapping.kt:83-85`).
- **Fingerprint is adapter-local, not cross-IDE** — `SymbolMapping.fingerprint` is SHA-256 of identifying fields, prefixed `"sha256:"`. It is not comparable with the VS Code adapter's and is not meant to be: a locator is relocated only by the adapter that minted it. What must agree is the relocation *rule*, pinned by shared vectors (ADR-0025) (`SymbolMapping.kt:113-119`).

## Key Types

### `SymbolHandleRegistry<A>` (`SymbolHandleRegistry.kt:28-228`)
Thread-safe (single `ReentrantLock`, `:64`), two-namespace handle store.
- `Draft<A>` (data, `:30-35`) — input: `locator`, `range`, `anchor`, `children`. Recursive tree.
- `Resolved<A>` (data, `:37-43`) — output of `resolve()`: `kind`, `documentUri`, `editorVersion`, `locator`, `anchor`.
- `Kind` (enum, `:45`) — `DOCUMENT` / `TRANSIENT`.
- `Context` (data, `:47-53`) — `adapterId`, `sessionId`, `workspaceId`, `workspaceEpoch`, optional `editorVersion`. Checked on every resolve.
- `Record<A>` (private data, `:55-62`) — stored per handle id.
- Constants: `DEFAULT_MAX_HANDLES = 20_000` (`:225`), `MAX_TRANSIENT_GENERATIONS = 5` (`:226`).

### `SymbolRelocation` (object, `SymbolRelocation.kt:22-83`)
Pure matching of a target locator against a current draft tree.
- `Draft` (data, `:27-31`) — `locator`, `range`, `children`.
- `Outcome` (sealed, `:33-39`) — `Resolved(draft)` / `NotFound` / `Ambiguous(candidates)`.
- `MAX_CANDIDATES = 32` (`:24`) — upper bound on candidates reported with `AMBIGUOUS_SYMBOL`.

## Key Functions

- `SymbolHandleRegistry.resolve(handle, context): Resolved<A>?` (`SymbolHandleRegistry.kt:78-85`) — Returns null for any handle not minted by this adapter in this session and epoch, or since invalidated. Caller falls back to relocation, not guessing.
- `materializeDocument(drafts, documentUri, context): List<Symbol>` (`:88-111`) — Replaces a document's symbol tree atomically: stages new records, invalidates the old document set, installs the new. Reserves capacity first.
- `materializeTransient(drafts, context): List<Symbol>` (`:117-144`) — Materializes individual results as their own generation; children are stripped (`draft.copy(children = emptyList())`). Adds a generation to `transientGenerations`; evicts oldest if > 5.
- `invalidateDocument(workspaceId, documentUri)` (`:147-148`) — Revokes every handle for a document in both namespaces.
- `invalidateAll()` (`:150-155`) — Clears everything.
- `reserveCapacity(additional)` (`:170-175`) — Evicts oldest transient generations until room exists; `require`s that capacity is not exceeded (document handles are protected).
- `SymbolRelocation.relocate(target, current): Outcome` (`SymbolRelocation.kt:41-51`) — Collects matches; single → Resolved; multiple → try selection-range tie-break; still multiple → Ambiguous (capped at 32).
- `isSameIdentity(candidate, target)` (`:69-76`) — Same document + name + kind; containerName compared only when both sides declare one (a flat search result legitimately lacks it).

## Data & Control Flow

```
Draft<A> tree (from PSI / search)
   │  SymbolHandleRegistry.materializeDocument()   ──► Symbol tree (protocol DTOs)
   │      ├─ mints handle ids (sym_ + 18 random bytes via WorkspaceModel.createIdentifier)
   │      ├─ atomic replace of document namespace, OR
   │      └─ FIFO generation for transient namespace (max 5, evict oldest)
   ▼
Symbol (with SymbolHandle: adapterId, sessionId, id, validUntilEpoch)
   │  ... later, on the wire back ...
   ▼
SymbolHandleRegistry.resolve(handle, context)
   │  ├─ match (adapterId, sessionId, validUntilEpoch, workspaceId)  ──► Resolved<A> (fast path, O(1) via anchor)
   │  └─ null (stale / wrong session / evicted)
   ▼
null  ──►  SymbolRelocation.relocate(target locator, current Draft tree)
              ├─ single semantic match      ──► Resolved
              ├─ + selection-range tiebreak  ──► Resolved
              ├─ none                       ──► NotFound
              └─ several                    ──► Ambiguous (≤32 candidates)
```

Handles are minted on background threads and invalidated from PSI change listeners; both go through the same `ReentrantLock` so they do not interleave (`SymbolHandleRegistry.kt:25-27`).

## Integration Points

- **Consumed by:**
  - Symbol/document providers (Phase 4 symbol services) call `materializeDocument` / `materializeTransient` to build `Symbol` trees for the wire.
  - `symbol/resolveAt` and navigation methods call `resolve()` first, then fall back to `SymbolRelocation` on null.
- **Depends on:**
  - `com.idebridge.jetbrains.protocol.*` — `Symbol`, `SymbolHandle`, `SymbolHandleId`, `SymbolLocator`, `Range`, `AdapterId`, `SessionId`, `WorkspaceId`.
  - `com.idebridge.jetbrains.workspace.WorkspaceModel` — `createIdentifier("sym_")` for handle-id minting (`SymbolHandleRegistry.kt:10,212`).
  - JDK concurrency (`java.util.concurrent.locks.ReentrantLock`, `kotlin.concurrent.withLock`).
- **External boundaries:**
  - Handle ids on the wire: `sym_` + 18 random bytes, URL-safe Base64, no padding (via `WorkspaceModel.createIdentifier`).
  - Relocation vectors: `packages/protocol/fixtures/vectors/symbol-relocation-vectors.json` (shared with VS Code, ADR-0025).

### `SymbolKindMapper` (interface, `SymbolKindMapper.kt:20-43`)
Extension point for language-specific symbol classification. `null` means "not mine" — the next mapper is tried; a declaration no mapper claims is `SymbolKind.UNKNOWN`.
- `EP_NAME` (`:26-27`) — `ExtensionPointName("com.idebridge.jetbrains.symbolKindMapper")`. The host IDE contributes mappers; CLion contributes C++ knowledge, PhpStorm PHP knowledge.
- `classify(element: PsiElement): SymbolKind` (`:37-42`, companion) — Asks every mapper the host IDE contributed, in registration order. Falls back to `UNKNOWN`, which is truthful for a named declaration whose category this IDE does not expose.

### `SymbolMapping` (object, `SymbolMapping.kt:26-174`)
Turns a language's declaration tree into IDEBP `SymbolHandleRegistry.Draft` trees. Free of platform types — the platform-facing binding only describes each declaration as a `Node<A>`.
- `Node<A>` (interface, `:37-51`) — One declaration as the platform sees it: `name`, `kind`, `declarationType`, `declarationStart/End`, `selectionStart/End` (identifier range, must lie inside the declaration), `anchor: A`, `children`.
- Constants: `MAX_DOCUMENT_SYMBOLS = 5_000` (`:27`), `MAX_SYMBOL_DEPTH = 64` (`:28`), `MAX_SYMBOL_TEXT_LENGTH = 1_024` (`:29`).
- `State` (private, `:68-71`) — Mutable traversal state: `count` and `seen` (identity set). Guards against cycles and structural overflow.
- `createLocator(...)` (`:121-137`) — Builds a `SymbolLocator` with a SHA-256 fingerprint. The fingerprint is **not** comparable with the VS Code adapter's and is not meant to be: a locator is relocated only by the adapter that minted it. What must agree across adapters is the relocation *rule*, pinned by shared vectors (ADR-0025).
- `fingerprint(...)` (`:139-161`, private) — SHA-256 digest of `[documentUri, name, kind.name, containerName.orEmpty(), selectionRange positions]`. Prefixed `"sha256:"`.

## Key Functions

- `SymbolMapping.mapDocument(nodes, documentUri, index): List<Draft<A>>` (`SymbolMapping.kt:59-66`) — Maps a document's declaration tree. Refuses (throws) rather than truncates: a result exceeding bounds would be indistinguishable from a document that genuinely has that few symbols. Checks depth ≤ 64, count < 5_000, and identity-cycle guard on every node.
- `SymbolMapping.map(node, documentUri, index, containerName, depth, state): Draft<A>` (`:73-110`, private) — Recursive. Guards: `depth <= MAX_SYMBOL_DEPTH`, `state.count < MAX_DOCUMENT_SYMBOLS`, `state.seen.add(node)` (identity check — a cycle would otherwise recurse until stack overflow). Validates that the selection range lies inside the declaration range. Children are mapped with `containerName = name`.
- `SymbolMapping.createLocator(documentUri, name, kind, selectionRange, containerName, declarationType): SymbolLocator` (`:121-137`) — Public. Builds a locator with `PositionEncoding.UTF16` and a fingerprint.
- `SymbolKindMapper.classify(element: PsiElement): SymbolKind` (`SymbolKindMapper.kt:37-42`) — Asks every extension-point mapper in registration order. Falls back to `UNKNOWN`. A consumer acting on a guessed kind is worse off than one told nothing — the name, range, and navigation all remain usable without it.
- `SymbolKindMapper.kindOf(element: PsiElement): SymbolKind?` (`SymbolKindMapper.kt:23`) — The method a language-specific mapper implements. `null` means "this mapper does not handle this element's language".

## Common Gotchas

- **Two namespaces are mandatory.** A search touching a document already explored must not revoke the handles that document handed out (`SymbolHandleRegistry.kt:113-116`). `materializeTransient` strips children and never touches `documentHandles`.
- **Eviction is transient-only.** `reserveCapacity` evicts oldest transient generations; it never evicts document handles to make room (`SymbolHandleRegistry.kt:166-175`). A long-lived registry must not fail a document request because of accumulated search history.
- **Max 5 transient generations.** `while (transientGenerations.size > MAX_TRANSIENT_GENERATIONS) evictOldestTransient()` (`:142`). Older search results are reclaimed generationally.
- **Capacity is a hard limit.** After evicting all transient generations, if `records.size + additional > maxHandles`, `require` throws (`:174`). Do not silently grow beyond 20 000.
- **Relocation matches semantic fields, not fingerprint.** Matching the fingerprint would fail for any symbol shifted by a single line — exactly when a handle goes stale (`SymbolRelocation.kt:9-13`). Match on `documentUri`, `name`, `kind`, and `containerName` (when both sides have it).
- **containerName is optional on both sides.** A locator minted from a flat search result legitimately lacks the container a hierarchical provider reports; treating that absence as a mismatch would make such a symbol unrelocatable (`SymbolRelocation.kt:64-76`).
- **Selection range is a tie-breaker, not a primary key.** It decides only when exactly one candidate still carries the original range (`SymbolRelocation.kt:46-49`).
- **Handle id uniqueness retries 16 times.** `createHandleId` retries on collision with `records` or `staged`; after 16 tries it errors (`SymbolHandleRegistry.kt:210-216`). With 18 random bytes this is defensive, not expected.
- **`resolve()` never guesses.** A null return means "fall back to relocation", not "return empty". The caller must not paper over a stale handle with a no-match result that looks like "no symbols" (`SymbolHandleRegistry.kt:73-77`).

---

## `PlatformSymbolKindMapper` (PlatformSymbolKindMapper.kt)

### Responsibility

The production implementation of `SymbolKindMapper` (extension point `com.idebridge.jetbrains.symbolKindMapper`).
Before this mapper existed, `classify` fell through to `SymbolKind.UNKNOWN` for every symbol of every
language — the kind field was structurally dead. This mapper authors no hand-maintained correspondence
table. Instead it reads the protocol's vocabulary out of the `kotlinx.serialization` serializer
descriptor at class-load time and asks whether the IDE's own `UsageViewTypeLocation` description used
one of those words. A word it does not recognise stays `SymbolKind.UNKNOWN` — exactly today's behaviour,
so nothing can regress.

### Key Types

- `PlatformSymbolKindMapper` (`:41`) — `public class : SymbolKindMapper`. Implements the extension
  point registered at `com.idebridge.jetbrains.symbolKindMapper`. Consumed by
  `SymbolKindMapper.classify()` which iterates extension-point mappers in registration order.

### Companion Object

- `EQUIVALENT_PHRASES: Map<String, SymbolKind>` (`:60-64`) — platform spellings of a single
  vocabulary word. Maps `"enum constant" → ENUM_MEMBER`, `"type parameter" → TYPE_PARAMETER`,
  `"local variable" → VARIABLE`. These are the opposite case from compound phrases: each is a
  multi-word spelling of exactly one vocabulary word with no second candidate to choose between.
  Listed individually so each can be checked, and they name no language.
- `BY_PLATFORM_WORD: Map<String, SymbolKind>` (`:72-79`) — the protocol's vocabulary, read from the
  wire contract rather than copied. Built from `serializer<SymbolKind>().descriptor` — iterates
  `SymbolKind.entries`, lowercases each `descriptor.getElementName(kind.ordinal)`, and merges with
  `EQUIVALENT_PHRASES`. Copying the list would let it drift from the schema silently; taking it from
  the serializer means a kind added to the protocol is understood here the moment it exists. Uses
  `@OptIn(ExperimentalSerializationApi::class)` (`:72`).

### Key Functions

- `kindOf(element: PsiElement): SymbolKind?` (`:43-49`) — Gets the IDE's own description of the
  element via `ElementDescriptionUtil.getElementDescription(element, UsageViewTypeLocation.INSTANCE)`,
  trims and lowercases it, and looks it up in `BY_PLATFORM_WORD`. Returns `null` for unrecognized
  words (falls through to `SymbolKind.UNKNOWN`). Uses `runCatching` (`:44`) because some languages
  throw when asked for a description they do not have — `getOrNull()` returns `null` in that case.

### Gotchas

- **No correspondence table authored.** The vocabulary is read from the serializer descriptor at
  class-load time (`:72-79`). A kind added to the protocol is understood here the moment it exists,
  without editing this file.
- **Compound phrases are refused, not resolved.** Java calls `static final int` a `constant field`
  and Kotlin calls a companion a `companion object`. Each names two vocabulary words at once, and
  picking one would be this plugin's judgement rather than the IDE's, so both stay unknown
  (`PlatformSymbolKindMapper.kt:33-35` doc).
- **Uses `@OptIn(ExperimentalSerializationApi::class)`** (`:72`) for `serializer<SymbolKind>().descriptor`
  access.
- **Platform normalises only as far as each language bothers to.** Kotlin's provider answers `class`
  for an `enum class` *and* for its entries, where Java distinguishes `enum` from `enum constant`. That
  coarseness is the IDE's own and is reported as the IDE gave it (`:29-31` doc).
- **Consumed by `SymbolKindMapper.classify()`** which iterates extension-point mappers in registration
  order; `null` means "this mapper does not handle this element's language" and the next mapper is
  tried.
