# ADR-0037: An integration test must name the process that answered it

- Status: accepted
- Date: 2026-08-14
- Related: [ADR-0020](0020-revisions-describe-what-was-read.md), [ADR-0034](0034-an-index-that-cannot-answer-says-so.md)

## Context

TASK.md §30 step 12 asks the demo to show a prepared plan refused after its document changes. On VS
Code it answered `PLAN_NOT_FOUND` for three days. Five explanations were proposed and each was
measured and eliminated: the 75 ms change debounce, a stale bundled daemon, a URI mismatch, a
missing revision, and a notification dropped silently by the extension's event bridge.

All five eliminations were correct about the thing they measured, and all five were irrelevant.

## Measurement

Instrumenting the daemon's plan store and rebuilding produced **no trace at all** — not for the
invalidation, not for the successful `applyPlan` of the preceding scenario. The instrumented binary
was verified present in `dist/daemon-child.js` both before the run and after the suite's own build.
A process that never executes cannot be exonerated by reading its source.

The daemon that answered was found by listing what was listening:

```
node .../packages/cli/dist/bin.js daemon --dashboard --log-level error   started 2026-08-11 13:45
$HOME/.ide-bridge/discovery.json → ws://127.0.0.1:60444/rpc, pid 48591
```

A daemon started by hand three days earlier, from a build that contained no `STALE_DOCUMENT` code
at all. `PLAN_NOT_FOUND` was that build's only possible answer, and it was correct.

The cause is one line of resolution. `resolveDiscoveryFilePath` distinguishes "not configured" from
"configured" by `undefined`, and `readAdapterConfiguration` passed the VS Code setting through
verbatim — whose declared default is `""`. An empty string is not `undefined`, so the resolver
treated it as an answer, skipped `IDE_BRIDGE_DISCOVERY_FILE` entirely, and returned the shared file
under `$HOME`. The launcher exported that variable specifically to sandbox the run; it had never
been read. The CLI passes `undefined` and was unaffected, which is why nothing else showed it.

## Decision

**An empty setting means unset.** `readAdapterConfiguration` trims the discovery-file setting and
passes `undefined` when nothing remains, so the environment is consulted as documented. The
end-to-end suite resolves the same way, with `undefined` rather than `""`.

**An integration test proves which process answered it.** The extension logs `daemon-autostarted`
when it owns the daemon; a run that attaches to a stranger's daemon does not log it. That line is
the difference between a suite that tests this build and one that tests whatever was left running.

**`doctor` names the daemon, not only its health.** The report carries `pid`, `startedAt` and
`uptimeSeconds` beside the checks, from the moment the discovery file parses — including when the
port is unreachable, which is when the question is most often asked. It repeats neither the token
nor the endpoint, because a diagnostic gets pasted into issues. Run against this machine while the
defect was still fresh, it printed seven passing checks and `uptimeSeconds: 240063` — every check
green, on a daemon nearly three days old. That single field is the evidence that was missing.

## Consequences

The end-to-end suite now starts and owns its daemon, and step 12 passes on the first run with
exactly `STALE_DOCUMENT` — verified by narrowing the assertion to that code alone before restoring
the pair the protocol allows.

Two defects found while chasing the wrong one are kept, because both were real: the event bridge's
seven silent drops now name themselves, and JetBrains' indifference to an on-disk write is recorded
in `DEMO.md` rather than rediscovered.

Making the drops visible immediately earned its keep. Every run reports one:
`dropped document/opened (unsupported-scheme)` — VS Code's own `chatSessionInput:input-0`. It is
correct to drop, and it was first reported as `outside-workspace`, which would have meant a real
file falling outside the registered roots was announced in the same words as permanent editor noise.
A buffer the editor invented is now its own reason, so the noisy case and the alarming one can never
again be read as the same event.

The general rule this project keeps paying for, in its third form: an answer that cannot say where
it came from is not evidence. Diagnostics that could not distinguish "clean" from "cannot analyse",
plans that could not distinguish "unknown id" from "invalidated", and now a suite that could not
distinguish its own daemon from someone else's.
