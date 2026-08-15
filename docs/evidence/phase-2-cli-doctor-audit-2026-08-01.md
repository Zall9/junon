# Phase 2 CLI and doctor audit — 2026-08-01

## Verdict

**ACCEPT after remediation on supported Unix platforms.** The real `ide-bridge` binary now runs the
daemon in the foreground and exposes all five required commands. Administration uses the shared
typed client, while ownership, discovery publication, signals, output channels, request timeouts,
and exit codes have explicit bounded behavior.

Phase 2 remains formally **In progress** only because Windows owner-only discovery ACL creation and
validation are deliberately unsupported and cannot be validated in this Unix environment. Real IDE
adapter integration belongs to Phases 3 and 4.

## Boundary audited

- package ownership and daemon/client dependency direction;
- default and explicit discovery paths;
- single-instance races, crash state, and clean ownership release;
- publication ordering and token/endpoint exposure;
- `SIGINT`/`SIGTERM`, early startup failure, and idempotent cleanup;
- stdout versus stderr and stable exit codes;
- administration request validation and timeout bounds;
- doctor evidence for discovery, permissions, PID, port, protocol, adapters, and sessions;
- actual monorepo binary wiring and CI execution order.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| CLI-01 | Critical | Implementing commands inside the daemon package would duplicate the shared client or create a daemon/client cycle. | Added a separate CLI package depending on both libraries; all administration uses typed client requests. |
| CLI-02 | Critical | Atomic discovery replacement alone permits concurrent daemons to overwrite one another. | Added a complete private owner record published with atomic no-clobber linking, live-PID refusal, and atomic dead-owner recovery. |
| CLI-03 | High | Clean shutdown could remove another daemon's rotated discovery file. | Removal requires exact endpoint, token, PID, and start-time ownership while the CLI lock is held. |
| CLI-04 | High | Signal handlers installed only after readiness leave a startup termination window. | Signal listeners are installed before ownership/startup and disposed on every success/failure path. |
| CLI-05 | High | Administration could wait for the client's broad default request timeout. | Every CLI request has an explicit five-second bound; handshakes retain the client's four-second bound. |
| CLI-06 | High | `doctor` could overclaim checks after discovery or port failure. | Checks use `pass/warn/fail/skip`; dependent checks are skipped and no repair is attempted. |
| CLI-07 | Medium | Raw filesystem/client errors can expose paths or metadata. | CLI output maps failures to a closed canonical error set and never includes raw messages or stacks. |
| CLI-08 | Medium | A compiled `bin` entry did not initially create a root monorepo command. | Root now depends on the workspace CLI, `node_modules/.bin/ide-bridge` is executable, and CI runs `pnpm cli:smoke`. |
| CLI-09 | Medium | Session expiration cannot be inferred from defaults when heartbeat settings are configurable. | Doctor rejects only activity older than the maximum permitted heartbeat window and documents that conservative proof. |
| CLI-10 | Medium | Automatically detaching would obscure ownership, shutdown, and logs. | MVP daemon is foreground-only; external supervisors own background execution. |

## Verification

Focused coverage includes:

- all commands/options, help, usage errors, environment/default/relative paths;
- `0600` atomic owner publication, live-owner rejection, dead-owner recovery, malformed-state refusal;
- real child-process daemon startup and ready output;
- real private discovery file and loopback WebSocket authentication;
- separate-process `status`, `adapters`, `workspaces`, and `doctor` calls;
- duplicate daemon refusal;
- doctor warning for no adapter without failing otherwise healthy infrastructure;
- `SIGTERM` graceful exit, stopped log, and owned discovery/lock removal;
- stable usage/doctor exit codes and absence of token/path leakage;
- root `ide-bridge --help` binary smoke test.

## Validation results

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install across seven workspace projects: pass;
- Prettier format check and ESLint: pass;
- strict TypeScript typecheck across six packages plus scripts: pass;
- all six TypeScript package builds: pass;
- root `ide-bridge --help` binary smoke test: pass;
- complete Vitest suite: 30 files / 189 tests;
- CLI: 3 files / 8 tests, including real child processes and loopback sockets;
- bridge-daemon: 9 files / 67 tests;
- bridge-client: 7 files / 42 tests;
- protocol: 9 files / 70 tests;
- protocol runtime catalogue and fixtures: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture typecheck, Java fixture compilation, and PHP fixture lint: pass.

## Remaining platform limitation

Windows stays fail-closed until owner-only discovery and ownership ACLs have a native implementation
and Windows runtime evidence. No Unix-mode approximation is used.

## Next audit boundary

Phase 3 begins the VS Code adapter. Audit extension-host activation/deactivation, shared-client
ownership, discovery/auto-start configuration, workspace trust, URI mapping, revision hashing from
the in-memory buffer, provider cancellation, `WorkspaceEdit` application, and official extension
host integration before implementation.
