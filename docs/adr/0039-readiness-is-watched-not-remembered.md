# ADR-0039: Readiness is watched, not remembered

- Status: accepted
- Date: 2026-08-14
- Related: [ADR-0034](0034-an-index-that-cannot-answer-says-so.md), [ADR-0038](0038-the-party-that-applies-a-plan-checks-it.md)

## Context

`workspace/getStatus` is a consumer-local method: the daemon answers it from the last
`workspace/readinessChanged` the adapter pushed. The request never reaches the IDE. The JetBrains
adapter pushed on dumb-mode transitions and nowhere else.

So readiness described the last moment the *index* changed, not whether the IDE could answer.

## Measurement

On 2026-08-14, driving a real IDE:

```
getStatus        0.00s  ready
getRevision     30.00s  [TIMEOUT] retryable=True
getSymbols      30.00s  [TIMEOUT] retryable=True
searchSymbols   30.00s  [TIMEOUT] retryable=True
```

Thirty seconds exactly is the daemon's route timeout: those requests were never served. The IDE was
waiting on `MemoryDiskConflictResolver` — *"reload from disk?"* — raised because a demo script had
written fixture files back while the IDE held them modified. Its event thread was blocked on a click
nobody would make, so no read action could run, so every route failed. And `getStatus` kept answering
`ready`, instantly, for as long as it lasted.

Nothing was going to change that. A blocked IDE announces nothing, and readiness had no other source.

## Decision

**The adapter watches, on a timer, and announces on change.** `ReadinessWatchdog` runs every 5 s —
well inside the 30 s route timeout, so a consumer learns before its own call fails.

**The probe asks the question the routes ask**: can a read action run within 2 s. A probe measuring
anything else would report health the routes do not have. The 2 s bound is generous on purpose: a
busy but working IDE answers in milliseconds, and calling a slow moment `degraded` would trade one
wrong answer for another.

**A blocked IDE is `degraded`, and outranks the index.** Indexes may be perfectly built; what has
stopped is the ability to answer. `capabilitiesUnavailable` then lists *everything* the adapter
serves, including `document/read`, which needs no index and still needs a read action.

**Announcements are made only on transition.** The daemon broadcasts each one to every consumer; a
stuck IDE announcing per tick would be a broadcast storm.

## Consequences

`degraded` is emitted for the first time by any adapter in this project. It was in TASK.md §13 and in
the schema from the start, and nothing produced it.

The watchdog is a plain class taking a probe, an index reader and a publisher, so its behaviour is
unit-tested without an IDE and proved by mutation: a failing probe means degraded, a blocked IDE
outranks a healthy index, recovery is announced too, and a reset makes the next tick speak.

**Proved live.** The quiet case first: across roughly two hundred ticks in seventeen minutes the
heartbeat announced exactly once, at link time. Then the blocked case, unprompted — a real IDE
producing, in its own log,

```
jetbrains-plugin is smart
jetbrains-plugin is dumb
jetbrains-plugin is blocked
jetbrains-plugin is smart
```

as it opened a project: indexing, a moment when no read action could run, and recovery. Every
transition announced, none repeated. Before this, all four moments read `ready`.

## The defect this introduced, and its fix

Adding the heartbeat gave the transport a second sender, and the announcer a third. The JDK's
`WebSocket` permits exactly one send in flight; a second throws `IllegalStateException: Send
pending`. It appeared in a real IDE within minutes, as a burst of dropped notifications.

`WebSocketTransport.send` now serialises on a lock — in the transport, not in each caller, because
the constraint belongs to the socket and a rule every future caller must remember is a rule that
will be forgotten. `TransportSendSerialisationTest` drives eight threads through it and fails if two
sends ever overlap.

Worth stating because it is the shape of the risk in this whole area: the adapter had one sender for
months, and nothing in the type system said so.
