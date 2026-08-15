# How this project verifies things, and what that has caught

## The method

Audit → implement → **prove each guarantee by isolated mutation** → ADR + plan-log entry → full
cross-stack validation. A test that passes on good input only is treated as no test.

## The lesson that outranks the others

**Run the IDE.** Every serious defect this project has had was found by driving a real IDE, not by a
failing test — and in each case the test suite was green at the time.

- `refactor/prepare` was a **black hole** in the daemon: added to `PLAN_STORE_METHODS` without a
  dispatch case, it swallowed every request — no route, no response, not even the route timeout. It
  was the one routed method with no routing test.
- Quick-fix titles shipped as `(not initialized) class …QuickFix`, then as `<html>…</html>`, then as
  `"Annotator"`. Three defects, all found by **reading a capture**, none of which would have failed
  anything.
- `workspace/undo` reverted the document but PSI had not caught up, so the adapter reported a
  modified document whose hashes matched and the daemon refused it — **correctly**.

## Verify which *process* answered, not which build exists

VS Code's §30 step 12 failed for three days and produced five confident eliminations — the 75 ms
debounce, the bundled build, a URI mismatch, a missing revision, a dropped notification. Each was
measured correctly. Each was irrelevant: the suite was attached to a daemon started by hand three
days earlier, from a build containing no `STALE_DOCUMENT` at all, because `readAdapterConfiguration`
passed the discovery-file setting through verbatim and its default is `""` — which the resolver
reads as a configured path, so `IDE_BRIDGE_DISCOVERY_FILE` was never consulted (ADR-0037).

What broke the deadlock: instrumenting the daemon's store, rebuilding, and getting **no trace at
all** — not even from the scenario that passed. **An absence of output is a measurement.** The suite
now proves ownership: the extension logs `daemon-autostarted`, and a run attached to someone else's
daemon does not. `lsof -nP -iTCP -sTCP:LISTEN` plus the discovery file's `pid`/`startedAt` settles
the question in one command.

## Trust the assertion over your explanation of its failure

`fails closed when an apply result does not match its prepared document set` failed three times while
three successive explanations were wrong. The cause was a **123-byte ceiling on WebSocket close
reasons**: over it, `close()` throws rather than truncating, so the session stays open and a
contract-violating adapter keeps its connection.

Two rules follow. **Assert the consequence, not the message** — a test on the error string would have
passed while the security property broke. And when a test resists an explanation twice, **measure the
mechanism** instead of producing a third.

## A refusal that cannot name itself costs days

Both the daemon and the adapter mapped every failure to a bare code and discarded the cause. Naming
them answered in one run what had cost two increments of hypotheses. Guards now enforce it: no bare
`PROVIDER_FAILED` in the router, and every literal close reason within 123 bytes.

## Four vacuous tests, all caught by running the mutation

A UTF-16 test comparing an index with itself; a cycle test passing on the depth bound; a
stale-snapshot test whose fixture had no offers left to find; a hierarchy test asking for `callers`
against an implementation that hardcoded `callers`. **Each passed until the mutation was actually
run.** A mutation that does not compile proves nothing either — that one nearly got recorded as a
pass.

## Guards that exist because something slipped past

- **`checkInternalApiSurface`** — the Plugin Verifier's `failureLevel` is all-or-nothing, so internal
  API is checked against `internal-api-baseline.txt`. `javap` is **not** authoritative for
  `@ApiStatus.Internal`; it misled twice.
- **Count guards** on message types and methods, so adding one is acknowledged rather than absorbed.
- **Staleness guard**: the VS Code capability check compares the built `IDEBP_ROUTED_METHODS` against
  the protocol **source**, because a stale `dist` made it pass while a method was missing — three
  times in one day, always at the moment a method was added.
- **Non-vacuity guards on captures**: a missing capture used to take five checks quietly with it.

## Smaller traps worth remembering

- Schemas are **never compiled** — imported with JSON import attributes, read from source at runtime.
  Comparing `dist` and `src` timestamps produces false alarms.
- `BasePlatformTestCase` reuses one project per class; bookmarks live on the project, so a test that
  adds one leaks into the next.
- Read a file **while the IDE is still running**. A reading taken after killing it showed a rename
  still on disk and looked like a broken undo.
