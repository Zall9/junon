# test/…/symbol/

## Responsibility

Tests for the identity a consumer holds on to: handles, the locators that survive them, and what
happens to both when the text underneath moves.

## Design

**A handle is bound, and refuses anything else.** It carries adapter, session and epoch, and a handle
from another adapter, session or epoch is refused rather than resolved to whatever now sits at that
position.

**Recomputation must not revoke someone else's handles.** Re-reading a document replaces exactly its
own handles, and a transient result — a search hit — never revokes the ones a document listing handed
out. That distinction is the difference between a stable reference and one a background search can
invalidate.

**Relocation is pinned by vectors shared with the daemon**, not by hand-written scenarios here:
`SymbolRelocationTest` agrees with those vectors on every case, and a second test asserts the vectors
actually exercise every outcome — a shared corpus that only covers the easy half is worse than none.

## Flow

```
SymbolHandleRegistryTest  binding, resolution, refusal, per-document replacement, transient results
SymbolMappingTest         declaration and selection ranges, containment, children
SymbolRelocationTest      agreement with the shared relocation vectors, and their coverage
```

## Integration

The same handles travel through `service/AdapterBackend` and are rewritten by the daemon before a
consumer sees them; the vectors are shared with the TypeScript side so both implementations relocate
identically.
