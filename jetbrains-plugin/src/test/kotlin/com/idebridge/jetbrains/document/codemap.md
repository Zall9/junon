# test/…/document/

## Responsibility

Tests for how a document is described on the wire: which root it belongs to, what its revision says,
and what its content hashes to.

## Design

**A revision describes its source honestly.** A buffer carries an editor version and the workspace
epoch; content read from disk claims no editor version and is never dirty (ADR-0020). The two are not
interchangeable, and the tests pin that they are not.

**The hash is of content, not of provenance.** Identical text hashes identically whether it came from
a buffer or from disk — so a consumer comparing revisions is comparing what it read, not how it was
read.

**Root selection is part of describing a document.** A document is reported under the root that
actually contains it, and one outside every root is refused rather than attributed to the nearest.

## Flow

```
DocumentModelTest   buffer vs disk revisions, editor versions per document and monotonic,
                    content hashing, root selection, refusal outside every registered root,
                    and a traversal that would escape a root
```

## Integration

Every route that names a document goes through this model, so its rules hold uniformly across reads,
symbols, diagnostics and edits.
