# ADR-0005: Operation-dependent capability dimensions

**Status:** Accepted  
**Date:** 2026-08-01

## Context

IDEBP capabilities share a mandatory support level, but their other properties answer different
questions. Symbol resolution and refactoring expose a semantic or textual `guarantee`; edit
application exposes `atomicity`; preparable operations may expose `preview`. Requiring a guarantee
for every available capability rejects the canonical `workspace.applyEdit` example in `TASK.md`,
which declares support and atomicity only.

## Decision

- `support` is mandatory for every capability.
- `guarantee` is present when the capability claims semantic, syntactic, anchored-text, or raw-text
  quality.
- `atomicity` is present when application behavior is meaningful.
- `preview` is present when preparation or preview is meaningful.
- An absent dimension means “not applicable”; consumers must not infer a guarantee or atomicity.
- `support: "unavailable"` remains a separate variant and cannot carry available-capability
  dimensions.
- Capability-specific requirements are enforced by adapter conformance tests. In particular,
  semantic, syntax-aware, anchored-text, and raw-text operations must announce their guarantee.

## Consequences

- The generic capability map represents `workspace.applyEdit` without inventing a semantic quality.
- Consumers must branch on the capability key before interpreting optional dimensions.
- Adding a new dimension does not require weakening unrelated capability contracts.

## Alternatives considered

### Require `guarantee` for every available capability

Rejected because it contradicts the product-scope example and gives atomic application operations a
misleading semantic label.

### Use explicit `null` for non-applicable dimensions

Rejected because omission is smaller on the wire and keeps generated types idiomatic.

### Define a separate schema for every capability key

Deferred. It would provide stronger key-specific validation but substantially increase the Phase 1
surface. Phase 5 conformance tests will enforce the key-specific matrix.
