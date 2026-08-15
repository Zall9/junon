# test/…/workspace/

## Responsibility

Tests for what a workspace *is* to a consumer: its identity, its roots, what URIs belong to it, and
whether it can answer right now.

## Design

**Readiness is tested as a mapping and as a watcher, separately.** `ReadinessModelTest` covers the
states an index can be in; `ReadinessWatchdogTest` covers the one an index cannot describe — the IDE
answering nothing at all — and the rule that announcements go out only on change, because the daemon
broadcasts each to every consumer.

**Containment is checked against the daemon's own vectors, not against local intuition.** The same
rule decides what an adapter may report and what the daemon will authorise, so `WorkspaceUriTest`
agrees with the shared corpus case by case — and a second test asserts that corpus exercises both
outcomes, since a shared corpus covering only the easy half is worse than none. A NUL byte in a
decoded path fails closed.

## Flow

```
WorkspaceModelTest          identity, roots, epoch
WorkspaceUriTest            URI containment
ReadinessModelTest          index state → protocol readiness, and which methods each state blocks
ReadinessWatchdogTest       a blocked IDE is degraded, outranks the index, and is announced once
RealDaemonRegistrationTest  registering against a daemon that is actually running
```

## Integration

`ReadinessWatchdog` publishes through the connection service; these tests drive it with a fake probe
and publisher, so the rule is provable without an IDE.
