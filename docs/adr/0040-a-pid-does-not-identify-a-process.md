# ADR-0040: A pid does not identify a process

- Status: accepted
- Date: 2026-08-17
- Related: [ADR-0035](0035-the-dashboard-shows-what-it-can-prove.md), [ADR-0037](0037-an-integration-test-must-name-the-process-that-answered.md)

## Context

Serena's dashboard picks its port at start-up from whatever is free — four were seen on one machine
in one evening, on 24282, 24283, 24284 and 24286 — so the IDE cannot guess it. Each JUNON process
therefore publishes `~/.ide-bridge/dashboards/<pid>.json` naming its own URL and pid, and two readers
consume it: `junon/dashboard_registry.py` on the way in, and `JunonDashboards.kt` in the JetBrains
tool window.

Both decided an entry was live from the pid alone — `os.kill(pid, 0)` on one side,
`ProcessHandle.of(pid).isAlive` on the other. Both files carried a comment saying that sending
someone to a dead port is worse than showing no link at all. Neither check could deliver that. A pid
is not an identity; it is a number the kernel lends out and later takes back.

## Measurement

Twenty entries were sitting in the directory on 2026-08-17. Nineteen were dead, the oldest three days
old. They accumulate because an entry is only removed when a reader happens to read it, and nothing
reads this directory unless a tool window is open.

Nothing was observed offering a link to a recycled pid, and that is the shape of the defect rather
than an argument against it: when it happens it is silent, and what the user gets is a link to a port
that is not a dashboard — indistinguishable, from the outside, from the plugin being broken.

Because the writer is Python and one of the two readers is the JVM, the comparison was measured
before it was chosen. On macOS, for the same pid:

```
psutil    Process(pid).create_time()        1786899750.370856
JVM       info().startInstant()             1786899750370 ms
```

The same kernel field, truncated to milliseconds. Linux rebuilds both from clock ticks since boot
plus a boot time that is only known to the second, and can therefore disagree by more.

Verified afterwards on a real entry, published in production by a JUNON that started at 09:58:13 and
read back the way the plugin reads it:

```
started_at (Python)  1786953493.905149
startInstant (JVM)   1786953493.905
ecart                0.000149 s        -> accepted, same process
```

## Decision

**An entry records the start time of the process that wrote it.** A fifth field, `started_at`, in
epoch seconds, read from the operating system — `psutil` on the writing side, `ProcessHandle
.startInstant()` on the JVM side. Both readers require the pid to be alive *and* that start time to
match. A pid can come round again; a pid that came round again at the same instant cannot.

**The match is approximate, and the tolerance is two seconds.** Not zero, because the two sides ask
different plumbing for the same fact — 149 µs apart in the measurement above, and coarser on Linux.
Two seconds sits far above that disagreement and far below anything that could produce a false
match: the pid counter would have to wrap the whole way round and land on this number again within
two seconds of the original process starting. Demanding exact equality would show no dashboards at
all on some platforms, and an empty list reads as a broken plugin rather than as a stopped dashboard.

**An entry with no start time is accepted on its pid alone.** It was written before the field
existed, and refusing those would empty the tool window for every JUNON running at the moment of an
upgrade. The cost is explicit: those entries keep exactly the weakness this removes, no reader will
retire them, and clearing them once is a step the documentation has to name rather than assume.

**`psutil` is declared, not borrowed.** It already arrives inside Serena's own dependency tree, which
is precisely why `pyproject.toml` names it: this package is installed *into* an environment it does
not control, and a guarantee resting on someone else's transitive dependency is one upstream can drop
without ever knowing it was load-bearing. Where the start time cannot be read at all, the check
degrades to the pid rather than raising — `publish` runs inside Serena's agent constructor, where
anything raised takes the whole server down with it.

**The start time is read from the operating system, never declared.** The daemon's discovery file
also carries a `startedAt`, and it is a different kind of thing: an ISO string the daemon writes
about itself. A timestamp a process chose for itself cannot settle whether the process now holding a
pid is the one that made the claim; only the kernel's answer can.

## Consequences

The registry is one file with two implementations, so they change together or they drift. The
tolerance constant on each side names its counterpart, and the Kotlin test file carries a real entry
from the Python writer verbatim, because its fixtures are hand-copied and a fixture that has stopped
resembling the real output tests nothing. Writing those fixtures by interpolating a `Double` would
have rendered `1.7869E9`, which parses back happily and resembles no `json.dumps` output ever
produced — so they are built as plain decimals on purpose.

Both sides are held to the guarantee by mutation. Accepting any start time, demanding an exact one,
and failing to record or to parse the field each fail exactly the test that names the guarantee, and
nothing else.

Known and not addressed here: the daemon's own discovery file has the same shape of weakness.
`ownership.ts` proves ownership with `isProcessAlive(pid)` and a self-declared `startedAt`, so a
reader cannot check it against the live process the way this now can.

The general rule this project keeps paying for, in its fourth form: an answer that cannot say where
it came from is not evidence. Diagnostics that could not distinguish "clean" from "cannot analyse",
plans that could not distinguish "unknown id" from "invalidated", a suite that could not distinguish
its own daemon from someone else's — and now an address that could not distinguish the process that
published it from whatever inherited its number.
