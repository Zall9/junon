# Phase 2 shared-client reconnection audit — 2026-08-01

## Verdict

**ACCEPT after remediation.** The shared TypeScript client now provides an opt-in connection-lifetime
facade that recovers after a real daemon restart and endpoint/token rotation without replaying
uncertain work or weakening discovery validation.

This does not complete Phase 2. Heartbeat and server-side session expiration, structured redacted
logging, CLI/doctor, Windows discovery ACLs, and real IDE adapter integration remain pending.

## Boundary audited

- Discovery endpoint/token rotation across daemon processes.
- Initial-connect versus post-establishment retry semantics.
- Retry concurrency, exponential backoff, jitter, and hard option bounds.
- New session identity and invalidation of session-bound plans, handles, and requests.
- In-flight request behavior and prohibition of automatic replay/queuing.
- Persistence and disposal of routed-request and notification handlers.
- Adapter registration restoration from current IDE state.
- Restoration timeout, cooperative cancellation, and ignored-cancellation bounds.
- Old connection close, candidate completion, restoration, and explicit-close races.
- State snapshot privacy and listener-failure containment.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| RC-01 | Critical | A cached discovery object cannot survive daemon port/token rotation. | Every retry reopens and fully validates the private discovery file. |
| RC-02 | Critical | Replaying an in-flight request could duplicate a write whose result is unknown. | Physical-close rejection is retained; reconnecting calls fail immediately and no request or notification is stored for replay. |
| RC-03 | Critical | Plans, undo tokens, symbol handles, and IDs are bound to the old session. | Every handshake is exposed as a new cloned session; no session-bound value migrates. |
| RC-04 | High | A successful adapter handshake is unusable until daemon registration is rebuilt. | A bounded restoration callback runs after persistent handlers attach and before the candidate is published as connected. |
| RC-05 | High | Timeout followed by another restoration could accumulate callbacks that ignore cancellation. | Timed-out restoration closes the candidate and retains the sole restoration slot until the actual callback promise settles. |
| RC-06 | High | Close, retry delay, handshake, restoration, and old-generation completion can race. | One lifecycle signal, exact connection identity, and a monotonic generation make explicit close terminal and candidate publication atomic. |
| RC-07 | Medium | Immediate retries can hammer a restarting daemon. | Exponential delay has configurable jitter and hard 1–60,000 ms / multiplier 1–10 bounds. |
| RC-08 | Medium | Physical handler registrations disappear with their socket. | Logical facade registrations attach to each generation and dispose from both active and candidate connections. |
| RC-09 | Medium | Connection/retry diagnostics could expose discovery metadata. | Public state contains only status, attempt/delay, and cloned authenticated session metadata—never endpoint, token, file path, or raw error. |
| RC-10 | Medium | The daemon package banner claimed that an unimplemented CLI existed. | The banner now identifies heartbeat, logging, and CLI as pending. |

## Verification

The focused client suite covers:

- real daemon shutdown followed by a new daemon, port, token, and session;
- calls rejected while reconnecting;
- in-flight routed request rejection without replay;
- adapter re-registration before connected publication;
- routed and notification handler persistence across sockets;
- capped deterministic backoff and terminal explicit close;
- one timed-out uncooperative restoration callback with no accumulation;
- reconnect bounds rejected before discovery I/O;
- pre-aborted one-shot handshake cancellation.

## Validation results

All commands ran successfully under Node 24.15.0 and pnpm 10.32.1 on 2026-08-01:

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | Pass; lockfile current, all six workspace projects already installed. |
| `pnpm format:check` | Pass; all matched files use Prettier formatting. |
| `pnpm lint` | Pass. |
| `pnpm typecheck` | Pass; five TypeScript packages plus scripts in strict mode. |
| `pnpm -r build` | Pass; protocol, conformance, daemon, client, and VS Code extension. |
| `pnpm test` | Pass; 26 files / 167 tests. |
| `pnpm --filter @ide-bridge/protocol test` | Pass; 9 files / 70 tests. |
| `pnpm --filter @ide-bridge/bridge-client test` | Pass; 7 files / 41 tests. |
| `pnpm --filter @ide-bridge/bridge-daemon test` | Pass; 8 files / 54 tests. |
| `pnpm protocol:fixtures` | Pass; 161 compiled schema entries / 35 fixtures. |
| `pnpm protocol:generate:check` | Pass; generated declarations are current. |

The client tests use real loopback daemon server instances for endpoint/token rotation, in-flight
routed work loss, adapter restoration, and handler reuse across authenticated sessions. They do not
spawn separate operating-system processes; process-supervision testing belongs to CLI/daemon work.

## Next audit boundary

Before implementing heartbeat/session expiration, define heartbeat ownership and cadence, the
activity sources that refresh a session, daemon expiration timing, interaction with routed work and
plan invalidation, reconnect triggering, timer/resource bounds, and deterministic clock-based tests.
