# test/…/edit/

## Responsibility

Tests for the plan registry: what a prepared edit is, who may claim it, and when it is no longer
claimable.

## Design

**One shot.** A claimed plan is removed before the edit runs, so a retry cannot replay it.

**Every refusal is distinct.** Unknown, already consumed, wrong session, wrong workspace, stale epoch
and expired are separate answers; collapsing them would leave a caller unable to tell a mistyped
identifier from a plan its own edit invalidated.

## Flow

```
RenamePlanRegistryTest   registering, claiming, refusing, expiring
```

## Integration

The registry is the adapter's half; the daemon keeps its own store and rewrites the identifiers
between them. Whether the *documents* still match is checked in `service/AdapterBackend`, not here.
