# Phase 2 heartbeat and session-expiration audit — 2026-08-01

## Verdict

**ACCEPT after remediation.** The daemon now owns a bounded WebSocket control-frame heartbeat for
both session roles. Quiet responsive shared clients remain connected, while a peer that misses the
configured complete pong windows is expired through the authoritative session cleanup path.

This does not complete Phase 2. Structured redacted logging, CLI/doctor, Windows discovery ACLs,
process-supervision tests, and real IDE adapter integration remain pending.

## Boundary audited

- ADR-0001 heartbeat ownership versus adapter-only `ide/ping`.
- Ping cadence, missed-response semantics, and configuration bounds.
- Event-loop stalls and wall-clock changes.
- Pong and application-message activity refresh.
- Shared timer and per-session state bounds.
- Expiration versus normal shutdown, transport loss, and protocol failure reasons.
- Registry, adapter/workspace, active-route, plan, and undo cleanup reuse.
- Quiet shared-client behavior and ADR-0009 reconnection compatibility.
- Daemon shutdown and timer teardown.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| HB-01 | Critical | ADR-0001 selected ping frames but defined no cadence or missed-pong threshold. | ADR-0010 defines 15-second / three-window defaults with hard 1–60 second and 1–10 bounds. |
| HB-02 | Critical | Authenticated sessions never expired. | One transport-wide sweep sends ping frames and closes only sessions that exhausted complete response windows. |
| HB-03 | High | Wall-clock idle subtraction could expire peers after a clock jump or daemon event-loop stall. | Expiration counts processed heartbeat opportunities; one delayed sweep advances at most one step. |
| HB-04 | High | Adapter disconnect broadcasts always claimed `transport-lost`. | Transport propagates canonical `session-expired`, `shutdown`, `transport-lost`, or `error`; raw close text never crosses the boundary. |
| HB-05 | High | A separate expiration cleanup path could drift from route/plan ownership rules. | Every authenticated close calls the existing `ApplicationRouter.sessionClosed` path with its canonical reason. |
| HB-06 | Medium | Quiet consumers cannot call adapter-only `ide/ping`. | WebSocket ping/pong covers both roles; `ide/ping` remains a diagnostic application probe. |
| HB-07 | Medium | Pong activity did not update public session activity. | Pong and authenticated messages invoke registry `touch`; composed tests verify the surviving session timestamp. |
| HB-08 | Medium | Per-session timers would scale with connection count. | One unref'ed interval owns a bounded integer counter per authenticated socket. |
| HB-09 | Medium | A responsive shared client could be mistaken for idle without explicit client code. | Tests verify `ws` automatic pong keeps the one-shot/reconnecting shared-client socket healthy. |

## Verification

Focused coverage includes:

- automatic pong preserving quiet raw and shared-client sessions;
- deterministic manual sweeps expiring a client with `autoPong: false`;
- authenticated application traffic resetting heartbeat state;
- heartbeat option rejection before server startup;
- normal close classified as `shutdown`;
- router/protocol failures classified as `error`;
- expired adapter route failure, `session-expired` broadcast, adapter/workspace removal, registry
  timestamp refresh, and continued consumer requests.

## Validation results

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install: pass;
- Prettier format check and ESLint: pass;
- strict TypeScript typecheck across five packages plus scripts: pass;
- all five TypeScript package builds: pass;
- complete Vitest suite: 26 files / 174 tests;
- bridge-client: 7 files / 42 tests;
- bridge-daemon: 8 files / 60 tests;
- protocol: 9 files / 70 tests;
- protocol runtime catalogue and fixtures: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture typecheck, Java fixture compilation, and PHP fixture lint: pass.

## Next audit boundary

Before structured logging, define the event catalogue, stable fields and levels, redaction at the
serialization boundary, identifier/path treatment, sink failure behavior, rate/size bounds, and
tests proving tokens, source text, replacements, diagnostic contents, and raw provider errors never
appear.
