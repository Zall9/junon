# ADR-0012 — CLI Process Ownership and Doctor Semantics

## Status

Accepted — 2026-08-01

## Context

Phase 2 requires `ide-bridge daemon`, `status`, `adapters`, `workspaces`, and `doctor`. The daemon
library owns transport/session state, while administration commands are ordinary authenticated
consumers. Putting client WebSocket logic into the daemon package would duplicate the shared client
and create a daemon/client dependency cycle.

The discovery file is replaceable by design and therefore cannot alone enforce one foreground
daemon per configured path. A crash can also leave discovery metadata behind. Command output,
structured daemon logs, signals, and operational failures need stable semantics that never reveal
the authentication token.

## Decision

### Package and process model

- A separate `@ide-bridge/cli` workspace package produces the `ide-bridge` binary and depends on
  the daemon library plus the shared TypeScript client. Protocol and WebSocket logic are not copied.
- `ide-bridge daemon` runs in the foreground. Backgrounding, service installation, and arbitrary
  network bind configuration are unsupported in the MVP.
- The daemon binds loopback on a dynamic port, generates a fresh 256-bit token, acquires ownership,
  publishes discovery metadata, then emits one safe ready record on stdout.
- `SIGINT` and `SIGTERM` converge on one idempotent shutdown path: stop accepting work, close
  sessions, remove owned discovery metadata, release ownership, and exit successfully.

### Discovery path and single-instance ownership

- `--discovery-file <path>` selects an explicit path. Otherwise
  `IDE_BRIDGE_DISCOVERY_FILE` is honored; the fallback is `~/.ide-bridge/discovery.json`.
- Relative explicit paths are resolved against the current working directory. Empty/NUL-containing
  paths and unsupported Windows ACL behavior fail closed.
- A private sibling ownership file is published atomically with complete `{ pid, startedAt }`
  metadata before the daemon starts publishing discovery data.
- If the owner PID is alive, a second daemon refuses to start. If a valid owner is dead, its lock is
  atomically renamed away before retrying acquisition, so concurrent stale recovery still has one
  winner. Malformed or insecure lock state is not silently deleted.
- Clean shutdown removes discovery only when it still matches the daemon's endpoint, token, PID,
  and start timestamp, then removes its matching ownership file. Crash recovery replaces stale
  state only after ownership acquisition.

### Administration commands

- `status`, `adapters`, and `workspaces` read the private discovery file and connect as short-lived
  `consumer` sessions through `@ide-bridge/bridge-client`.
- They invoke only canonical typed methods: `bridge/getStatus`, `bridge/listAdapters`, and
  `workspace/list`. Connections are closed in `finally`.
- Successful command results are one JSON value on stdout. Operational failures produce one safe
  canonical error record on stderr; raw paths, endpoints, tokens, provider errors, and stacks are
  omitted.

### Doctor checks

`doctor` reports a bounded ordered list of `pass`, `warn`, `fail`, or `skip` checks:

1. discovery file parsing and protocol metadata;
2. Unix mode, owner, regular-file, and no-symlink guarantees;
3. advertised PID liveness;
4. authenticated loopback port reachability;
5. negotiated and advertised protocol compatibility;
6. registered adapter count and workspace readiness states;
7. session timestamps and absence of entries older than the maximum permitted heartbeat window.

The doctor does not claim to probe IDE functionality when no adapter exists; that is a warning.
Checks requiring a connection are skipped after an earlier discovery/connect failure. It never
repairs permissions, deletes state, starts a daemon, disables workspace trust, or exposes secrets.

### Output and exit codes

- Command results and the daemon ready record use stdout. Structured daemon logs use JSON lines on
  stderr through ADR-0011. Safe CLI errors and doctor reports remain machine-readable JSON.
- Exit `0`: command succeeded; doctor has no failed checks (warnings allowed).
- Exit `1`: operational failure or at least one failed doctor check.
- Exit `2`: invalid command-line usage.
- `--help` exits `0`. Unknown commands/options and missing option values exit `2`.

## Consequences

- CLI integration exercises the same discovery, authentication, validation, timeout, and error
  mapping as every other TypeScript consumer.
- Foreground supervision is deterministic across terminals, IDEs, and service managers.
- A killed process can leave private state, but the next daemon can recover a valid dead owner
  without racing another starter.
- Doctor distinguishes proven health, warning, failure, and unavailable evidence instead of
  presenting approximate checks as success.

## Alternatives considered

### Implement administration WebSocket calls directly in the daemon package

Rejected because it duplicates the shared client and creates divergent authentication/validation
behavior.

### Detach the daemon automatically

Rejected because portable ownership, log routing, upgrades, and shutdown require a real supervisor.

### Treat an existing discovery file as the lock

Rejected because atomic replacement permits two starters to overwrite each other and crash state
cannot be distinguished safely.

### Have doctor repair or delete unhealthy state

Rejected because a read-only health command has insufficient authority to mutate another process's
ownership or weaken filesystem security.
