# jetbrains-plugin/src/

## Responsibility

A path segment. Nothing lives here directly — Gradle's source-set layout puts production code under `main/` and tests under `test/`.

## Design

Not a boundary in the system: no code, no decisions, no dependencies of its own.

## Flow

Continue in [`main/`](main/codemap.md).

## Integration

None. This directory exists because Gradle's source-set layout puts production code under `main/` and tests under `test/`.
