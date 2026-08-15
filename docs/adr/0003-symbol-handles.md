# ADR-0003 — Symbol Handles and Locators

## Status

Accepted — relocation matching rule amended by [ADR-0018](0018-symbol-navigation-and-relocation.md)
(2026-08-02). Relocation matches the locator's semantic fields (name, kind, containerName) and uses
the selection range only to break ties; it does **not** match the fingerprint, which includes
position and would therefore fail for any symbol that moved. Everything else below stands.

## Context

IDEBP needs to identify symbols (functions, classes, methods, variables) across the protocol boundary. An agent may:

1. Find a symbol now and reference it later.
2. Prepare an edit on a symbol and apply it minutes later.
3. Search for symbols across a workspace.
4. Distinguish overloaded methods.
5. Handle same-name symbols in the same file.
6. Survive document changes that do not affect the target symbol.

A symbol name is not a sufficient identity:

- Multiple symbols can share a name (overloads, different scopes).
- A name may change (that is what rename does).
- Two files can contain symbols with the same fully qualified name.

VS Code uses `SymbolInformation` / `DocumentSymbol` with location (URI + range). JetBrains uses PSI elements with smart pointers. Neither is directly serializable over the protocol.

## Decision

Each symbol in IDEBP has two representations:

### 1. Handle (temporary, opaque, fast)

```json
{
  "handle": {
    "adapterId": "adapter_1",
    "sessionId": "session_1",
    "id": "sym_123",
    "validUntilEpoch": 151
  }
}
```

- `adapterId`: Which adapter created this handle. Prevents cross-adapter use.
- `sessionId`: Which session created this handle. Prevents cross-session use.
- `id`: Opaque adapter-generated identifier. May be a counter, UUID, or internal pointer. Not meaningful outside the adapter.
- `validUntilEpoch`: The `workspaceEpoch` (from ADR-0002) after which this handle is definitely invalid. The handle may become invalid earlier (on relevant document changes), but is definitely invalid after this epoch.

**Properties:**
- Opaque: the client must not interpret the `id` field.
- Fast: the adapter can resolve a handle to a PSI element or VS Code symbol in O(1).
- Temporary: invalidated when the document changes or the epoch advances.
- Bound: tied to adapter and session; cannot be transferred.

### 2. Locator (persistent, serializable)

```json
{
  "locator": {
    "documentUri": "file:///project/src/service.ts",
    "name": "update",
    "qualifiedName": "StreamService.update",
    "kind": "method",
    "containerName": "StreamService",
    "selectionRange": {
      "start": { "line": 10, "character": 2 },
      "end": { "line": 10, "character": 8 }
    },
    "fingerprint": "sha256:..."
  }
}
```

- `documentUri`: URI of the containing document.
- `name`: The symbol's simple name.
- `qualifiedName`: Fully qualified name (language-specific format, but opaque to the protocol).
- `kind`: Symbol kind (function, method, class, interface, etc. — enum shared with LSP concept).
- `containerName`: The containing symbol's name.
- `selectionRange`: The range of the symbol's identifier (not the full declaration range).
- `fingerprint`: SHA-256 hash of the symbol's identity-relevant properties (name, kind, qualifiedName, selectionRange). Used for relocation matching.

**Properties:**
- Persistent: survives across sessions (though resolution is not guaranteed if the document changed).
- Serializable: can be stored, logged, transmitted.
- Relocatable: the adapter can attempt to find the symbol again using the locator when a handle is stale.

### Handle invalidation

Handles are invalidated when:

1. The containing document's `editorVersion` changes (the adapter tracks which symbols are affected).
2. The `workspaceEpoch` advances past `validUntilEpoch`.
3. The adapter disconnects.
4. The session expires.

### Relocation

When a handle is invalid, the adapter attempts **controlled relocation** before returning `STALE_SYMBOL`:

1. Use the locator's `documentUri` to find the document.
2. Use the locator's `fingerprint` to match against current symbols.
3. If exactly one match: return a new handle.
4. If zero matches: return `STALE_SYMBOL`.
5. If multiple matches: return `AMBIGUOUS_SYMBOL` with all candidate locators.

### Overload and same-name handling

- Overloaded methods: the `selectionRange` and `fingerprint` distinguish them even if `qualifiedName` is identical.
- Same-name symbols in one file: the `selectionRange` and `containerName` disambiguate.
- If the adapter cannot uniquely identify a symbol from a search, it returns `AMBIGUOUS_SYMBOL` with candidates rather than picking arbitrarily.

### JetBrains-specific mapping

- Smart PSI element pointers (`SmartPsiElementPointer`) are used as the internal backing for handles when available and stable.
- Symbol pointers (from `SymbolPointer`) are preferred when available.
- The IDEBP locator is the fallback when neither pointer resolves.
- PSI objects are **never** exposed in the protocol. Always mapped to IDEBP DTOs.

## Consequences

- **Positive:** Handles provide O(1) resolution for recent operations (prepare → apply within the same session).
- **Positive:** Locators provide persistence and can be logged/stored without leaking internal state.
- **Positive:** Relocation provides resilience against minor document changes.
- **Positive:** `AMBIGUOUS_SYMBOL` prevents silent wrong-symbol operations.
- **Positive:** `validUntilEpoch` provides bulk invalidation without tracking individual handles.
- **Negative:** Two representations add complexity; the client must understand when to use which.
- **Negative:** Fingerprint matching on relocation has a cost (must scan symbols in the document).
- **Negative:** Relocation may fail if the symbol was renamed or moved, requiring the client to re-search.
- **Negative:** JetBrains smart pointers can become invalid even for unchanged symbols if the PSI tree is rebuilt; the locator fallback mitigates this.

## Alternatives Considered

### Name-only identification

- Pros: Simplest.
- Cons: Cannot distinguish overloads, same-name symbols, or renamed symbols. Fundamentally unsafe.
- Rejected: TASK.md §10 explicitly requires that a name is not a sufficient identity.

### URI + range only

- Pros: Maps to LSP `Location`.
- Cons: Range changes when the document is edited; no semantic identity. Cannot survive any document change.
- Rejected: Too fragile; does not support the prepare → apply lifecycle.

### Persistent ID per symbol

- Pros: Stable across changes.
- Cons: Neither VS Code nor JetBrains provides a stable per-symbol ID. Would require the adapter to maintain a persistent symbol database. Adds significant complexity and storage.
- Rejected: Out of scope for MVP. The handle + locator approach provides a good balance.

### Fully qualified name only

- Pros: Human-readable, serializable.
- Cons: Cannot distinguish overloads with the same qualified name. Does not survive renames.
- Rejected: Used as part of the locator, but not sufficient alone.
