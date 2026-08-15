# Phase 2 adapter inbound dispatch audit — 2026-08-01

## Verdict

**ACCEPT after remediation.** An authenticated adapter connection can receive every one of the
thirteen routed IDEBP methods through a typed handler, observe cooperative cancellation through an
`AbortSignal`, and return only a canonical, method-correlated result or normalized error.

This is not Phase 2 completion. JavaScript cancellation is cooperative and cannot preempt a
synchronous handler; adapters must yield during long operations as required by `AGENTS.md`.
Reconnection, heartbeat/session expiration, structured logging, CLI/doctor, and real IDE adapter
integration remain pending.

## Boundary audited

- JSON-RPC request versus notification classification after authentication.
- Session-role authority for outgoing requests/notifications and incoming traffic.
- The exact thirteen-method daemon-to-adapter routing surface.
- Handler registration, removal, runtime limits, and socket lifecycle.
- Duplicate IDs, duplicate handlers, missing handlers, and wrong-direction messages.
- Completion, timeout, cancellation, close, and ID-reuse races.
- Actual handler execution after cooperative timeout or cancellation.
- Cancellation crossing an already-sent response on separate sockets.
- Result/error validation and exception-data privacy.
- Real consumer → daemon → shared adapter-client integration.
- Protocol role-partition completeness and daemon/client reuse.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| AD-01 | Critical | Every method-bearing inbound message was classified as a notification. | Messages with both `method` and own `id` now enter exact request-schema dispatch. |
| AD-02 | Critical | The client API allowed either role to originate any method or notification. | Frozen protocol-owned role partitions now gate both client directions; the daemon derives its method sets from the same source. |
| AD-03 | Critical | Completion, timeout, cancellation, and close could race to emit more than one response. | Settlement atomically removes one identity-checked inbound record; late completions are ignored. |
| AD-04 | Critical | Freeing capacity at timeout could hide unlimited handlers that ignored cancellation. | Capacity counts actual handler promises and is released only when each promise settles. |
| AD-05 | High | An old cancelled handler could settle a later request reusing the same ID, and cancellation initially omitted the completed-ID reservation. | Active records are checked by object identity; every settlement path, including cancellation, reserves the ID during bounded grace. |
| AD-06 | High | Cancellation can cross a completed response because the consumer and adapter use different sockets. | A bounded 30-second completion grace absorbs exactly one valid late cancellation. |
| AD-07 | High | Invalid returns or thrown exception text could cross the wire. | Exact result validation and validated `BridgeAdapterRequestError` data are allowed; unexpected failures become generic `PROVIDER_FAILED`. |
| AD-08 | Medium | Multiple or absent handlers had no deterministic behavior. | Registration is singular and disposable; an absent handler returns `CAPABILITY_UNAVAILABLE`. |
| AD-09 | Medium | Inbound timeout and concurrency options could be invalid or unbounded. | Defaults are 30 seconds/128; hard maxima are 300 seconds/1,024 and invalid options fail before socket creation. |

## Verification

The audit is accepted only with all of the following green under Node 24.15.0:

- frozen pnpm installation;
- Prettier format check;
- ESLint and strict TypeScript typecheck;
- all five package builds;
- full Vitest suite, including real loopback consumer → daemon → adapter dispatch;
- protocol-only, bridge-client-only, and daemon-only test suites;
- 161 compiled runtime schema entries and 35 compatibility fixtures;
- schema-derived TypeScript generation freshness.

Expected suite totals after this increment were 25 Vitest files / 161 tests, including protocol
9 files / 70 tests, bridge-client 6 files / 35 tests, and bridge-daemon 8 files / 54 tests.

## Validation results

All commands ran successfully under Node 24.15.0 and pnpm 10.32.1 on 2026-08-01:

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | Pass; lockfile current, all six workspace projects already installed. |
| `pnpm format:check` | Pass; all matched files use Prettier formatting. |
| `pnpm lint` | Pass. |
| `pnpm typecheck` | Pass; five TypeScript packages plus scripts in strict mode. |
| `pnpm -r build` | Pass; protocol, conformance, daemon, client, and VS Code extension. |
| `pnpm test` | Pass; 25 files / 161 tests. |
| `pnpm --filter @ide-bridge/protocol test` | Pass; 9 files / 70 tests. |
| `pnpm --filter @ide-bridge/bridge-client test` | Pass; 6 files / 35 tests. |
| `pnpm --filter @ide-bridge/bridge-daemon test` | Pass; 8 files / 54 tests. |
| `pnpm protocol:fixtures` | Pass; 161 compiled schema entries / 35 fixtures. |
| `pnpm protocol:generate:check` | Pass; generated declarations are current. |

The bridge-client suite includes a real loopback integration path from a typed consumer request,
through the composed daemon and route-ID translation, into a typed adapter handler and back.

## Next audit boundary

Before implementing reconnection, define and audit discovery-file rereads, bounded backoff with
jitter, session and handler re-establishment, deterministic failure of in-flight requests, adapter
re-registration, cancellation during reconnect, and clean explicit shutdown.
