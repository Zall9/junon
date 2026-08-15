# packages/cli/src/

## Responsibility

The `@ide-bridge/cli` package implements a bounded, machine-readable CLI (`ide-bridge` binary) for foreground daemon ownership and read-only administration of the IDE Bridge. It provides five commands (daemon, status, adapters, workspaces, doctor), connects to a running daemon via `@ide-bridge/bridge-client` in consumer role with local topology, or starts the daemon directly in-process. All output is JSON lines — results on stdout, structured daemon logs and safe error envelopes on stderr. It never serializes discovery tokens, raw file paths, or raw exception text into command output.

## Design Patterns

- **Command Dispatcher** — `runCli` (run-cli.ts:94–144) switches on `parsed.command` to route to command handlers. Each command has its own handler function.
- **Dependency Injection via IO Interface** — `CliIo` (run-cli.ts:16–23) abstracts stdout/stderr writers and environment access, enabling test injection without touching `process` globals.
- **RAII-style Resource Management** — `withCliConsumer` (admin-client.ts:28–37) wraps connection lifecycle with a `try/finally` close. `runDaemonCommand` (daemon-command.ts:103–108) uses a `finally` block to guarantee server close, discovery-file removal, and ownership release.
- **Short-circuiting Health Check Chain** — `runDoctor` (doctor.ts:135–156) skips downstream checks when upstream prerequisites fail, emitting `{status:"skip", detail:"prerequisite-unavailable"}`.
- **Atomic File Lock with Stale Recovery** — `acquireDaemonOwnership` (ownership.ts:105–140) uses a temp-file + atomic `link` pattern; stale locks from dead PIDs are recovered via `rename` + `unlink`.
- **Error Code Mapping** — `operationalErrorCode` (run-cli.ts:45–61) translates library-specific exception classes into a stable `CliOperationalErrorCode` union for consistent machine-readable output.
- **JSON Lines Output** — `writeJson` (run-cli.ts:41–43) serializes every result as a single `JSON.stringify(value)` + newline line.

## Key Types

**`CliIo`** (run-cli.ts:16–23) — IO abstraction for the CLI entry point.

```typescript
interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}
```

**`CliCommand`** (arguments.ts:3) — Closed command union: `"daemon" | "status" | "adapters" | "workspaces" | "doctor"`.

**`ParsedCliArguments`** (arguments.ts:5–13) — Parsed result from the argument scanner.

```typescript
interface ParsedCliArguments {
  command: CliCommand | undefined;
  discoveryFile: string | undefined;
  logLevel: StructuredLogLevel; // default "info"
  logLevelSpecified: boolean;
  dashboard: boolean; // default false; daemon-only (ADR-0035)
  help: boolean;
}
```

**`CliUsageError`** (arguments.ts:15–29) — Thrown by `parseCliArguments` for malformed input. Carries a 6-code union: `missing-command | unknown-command | unknown-option | missing-option-value | invalid-log-level | unexpected-argument`.

**`CliOperationalErrorCode`** (errors.ts:1–8) — Stable error code union for operational failures: `already-running | daemon-unavailable | discovery-unavailable | internal-error | ownership-invalid | platform-unsupported | protocol-incompatible`.

**`CliOperationalError`** (errors.ts:10–18) — Error class carrying a `CliOperationalErrorCode`. Message is generic (`"IDE Bridge command failed"`) — no raw exception details leak.

**`DaemonOwner`** (ownership.ts:11–14) — Lock file content: `pid: number` (positive safe integer) and `startedAt: string` (ISO 8601).

**`DaemonOwnership`** (ownership.ts:16–19) — Acquired lock handle: `lockPath: string` and `owner: DaemonOwner`.

**`DoctorCheckStatus`** (doctor.ts:18) — `"pass" | "warn" | "fail" | "skip"`.

**`DoctorCheck`** (doctor.ts:20–31) — Individual health check result. `name` is a 7-value union: `discovery-file | permissions | daemon-process | port | protocol | adapters | sessions-expired`.

**`DoctorReport`** (doctor.ts:33–36) — `ok: boolean` (true when no check has status `"fail"`) and `checks: DoctorCheck[]`.

## Key Functions

**`runCli(argv, io)` → `Promise<number>`** (run-cli.ts:63–153)
Main CLI entry. Parses arguments, resolves discovery file path, dispatches to command handler. Returns exit code: 0 success, 1 operational error, 2 usage error. All output via `io.stdout`/`io.stderr` as JSON lines. Passes `parsed.dashboard` to `runDaemonCommand` in the daemon case (run-cli.ts:102).

**`parseCliArguments(argv)` → `ParsedCliArguments`** (arguments.ts:34–90)
Hand-written token scanner. Recognizes `--help`/`-h`, `--discovery-file <path>`, `--log-level <level>`, `--dashboard` (arguments.ts:70–73), and a single command token. Throws `CliUsageError` on invalid input. Enforces `--log-level` as daemon-only (arguments.ts:81–83). Enforces `--dashboard` as daemon-only — refused rather than ignored on other commands (arguments.ts:86–88).

**`runDaemonCommand(discoveryFile, logLevel, writeOutput, dashboard = false)` → `Promise<void>`** (daemon-command.ts:59–109)
Acquires ownership, generates auth token, starts `IDEBPDaemonServer`, writes discovery file, optionally starts the dashboard surface via `server.startDashboard()` (daemon-command.ts:94) when `dashboard` is true, emits ready JSON with `dashboard` URL field (daemon-command.ts:100), blocks on SIGINT/SIGTERM, cleans up in `finally`.

**`runDoctor(discoveryFile, options?)` → `Promise<DoctorReport>`** (doctor.ts:122–183)
Runs 7 sequential health checks with short-circuiting. `options.now` injectable for testing. Returns `{ok, checks}` where `ok` is `true` iff no check has status `"fail"`.

**`acquireDaemonOwnership(discoveryFile, owner)` → `Promise<DaemonOwnership>`** (ownership.ts:105–140)
Atomic link-based lock acquisition with up to 8 attempts (ownership.ts:9). Recovers stale locks from dead PIDs via `rename` + `unlink`. Throws `CliOperationalError("already-running")` if a live owner holds the lock or all attempts are exhausted.

**`releaseDaemonOwnership(ownership)` → `Promise<void>`** (ownership.ts:142–150)
Proof-bound deletion: reads current lock, only unlinks if `pid` and `startedAt` match. Silent catch — never deletes unproven ownership state.

**`resolveDiscoveryFilePath(explicitPath, options?)` → `string`** (paths.ts:4–24)
Resolution chain: explicit `--discovery-file` arg → `IDE_BRIDGE_DISCOVERY_FILE` env var → default `~/.ide-bridge/discovery.json`. Rejects empty strings and null bytes. Resolves relative paths against cwd.

**`connectCliConsumer(discoveryFile)` → `Promise<AuthenticatedBridgeConnection>`** (admin-client.ts:11–26)
Reads discovery file, connects via `connectBridgeClient` with `role:"consumer"`, `topology:{hostKind:"local",environmentKind:"local",uriSchemes:["file"]}`, `clientInfo:{name:"ide-bridge-cli",version:"0.0.0"}`. Throws `CliOperationalError("discovery-unavailable")` on read failure.

**`withCliConsumer(discoveryFile, operation)` → `Promise<T>`** (admin-client.ts:28–37)
RAII wrapper: connects, runs operation, closes connection in `finally`.

**`operationalErrorCode(error)` → `CliOperationalErrorCode`** (run-cli.ts:44–60)
Maps bridge-client exception classes to stable CLI codes: `BridgeHandshakeRejectedError` with `UNSUPPORTED_PROTOCOL_VERSION` → `"protocol-incompatible"`, otherwise → `"daemon-unavailable"`. `BridgeClientConfigurationError` → `"discovery-unavailable"`. Unknown → `"internal-error"`.

## Data & Control Flow

**Entry**: `bin.ts:5` calls `runCli(process.argv.slice(2), {stdout, stderr})`. Exit code set via `process.exitCode` (bin.ts:9).

**Main dispatch** (run-cli.ts:63–153):

1. **Parse** (run-cli.ts:65–71): `parseCliArguments(argv)` → `ParsedCliArguments` or `CliUsageError` → exit 2
2. **Help** (run-cli.ts:72–75): if `parsed.help`, print HELP text, exit 0
3. **Platform gate** (run-cli.ts:76–79): `win32` → `{error:"platform-unsupported"}`, exit 1
4. **Discovery path** (run-cli.ts:81–91): `resolveDiscoveryFilePath` → absolute path, or `{error:"discovery-unavailable"}`, exit 1
5. **Command dispatch** (run-cli.ts:93–144):
   - `daemon` → `runDaemonCommand` (with `parsed.dashboard`) → exit 0
   - `status` → `withCliConsumer` → `connection.request("bridge/getStatus", ...)` → exit 0
   - `adapters` → `withCliConsumer` → `connection.request("bridge/listAdapters", ...)` → exit 0
   - `workspaces` → `withCliConsumer` → `connection.request("workspace/list", ...)` → exit 0
   - `doctor` → `runDoctor` → exit 0 if `report.ok`, else exit 1
   - `undefined` → `{error:"usage", detail:"missing-command"}`, exit 2
6. **Error catch** (run-cli.ts:145–152): `{ok:false, command, error: operationalErrorCode(error)}` → exit 1

**Daemon startup** (daemon-command.ts:59–109):

1. `createShutdownSignal()` — register SIGINT/SIGTERM one-shot listeners (daemon-command.ts:20–38)
2. `acquireDaemonOwnership(discoveryFile, owner)` — file lock at `${discoveryFile}.lock` (ownership.ts:111)
3. `generateAuthenticationToken()` — 256-bit token
4. `new StructuredLogger({minimumLevel: logLevel, sink: createStderrJsonLineSink()})` — structured logs to stderr
5. `new IDEBPDaemonServer({expectedToken: token, logger})` — daemon server
6. `server.start()` → loopback endpoint
7. `writePrivateDiscoveryFile({filePath, endpoint, token, pid, startedAt})` → discovery file at `0600`
8. If `--dashboard`: `server.startDashboard()` → returns URL with launch token (daemon-command.ts:94)
9. `writeOutput({ok:true, command:"daemon", status:"ready", pid, ...dashboard})` — ready signal to stdout. When `--dashboard` was passed, includes `dashboard: <url>` with launch token (daemon-command.ts:100). URL written to stdout, not structured log (ADR-0011).
10. `await shutdownSignal.promise` — block until SIGINT/SIGTERM
11. **Finally** (daemon-command.ts:103–108): `shutdownSignal.dispose()`, `server.close()`, `removeOwnedDiscoveryFile`, `releaseDaemonOwnership`

**Discovery file cleanup** (daemon-command.ts:40–57): `removeOwnedDiscoveryFile` reads the current discovery file and only unlinks if all four fields match (`endpoint`, `token`, `pid`, `startedAt`). On any mismatch or error, the file is left intact — never remove discovery state whose ownership cannot be proven.

**Doctor check sequence** (doctor.ts:122–183):

1. `discovery-file` — `readPrivateDiscoveryFile` → pass/fail (doctor.ts:128–133)
2. `permissions` — `permissionCheck`: lstat, reject symlinks, check owner-only mode `0600` (doctor.ts:38–57)
3. **Short-circuit**: if discovery undefined → skip remaining 5 checks, return `{ok:false}` (doctor.ts:135–138)
4. `daemon-process` — `isProcessAlive(discovery.pid)` via `process.kill(pid, 0)` (doctor.ts:141–146)
5. `port` — `connectCliConsumer` → pass/fail (doctor.ts:148–156)
6. **Short-circuit**: if port fail → skip remaining 3 checks, return `{ok:false}` (doctor.ts:152–156)
7. `protocol` — `bridge/getStatus` + `compareProtocolVersions` against `PROTOCOL_VERSION` range (doctor.ts:159–176)
8. `adapters` — `adapterCheck`: `bridge/listAdapters` + `workspace/list` + `workspace/getStatus` per workspace (doctor.ts:63–93)
9. `sessions-expired` — `bridge/listSessions` + heartbeat window check (doctor.ts:95–120)
10. `connection.close()` in `finally` (doctor.ts:179–180)
11. `ok = checks.every(({status}) => status !== "fail")` (doctor.ts:182)

**Daemon identity** (`DoctorDaemonIdentity`, doctor.ts): alongside the checks, the report names
`discoveryFile`, `pid`, `startedAt` and `uptimeSeconds` — present from the moment the discovery file
parses, including when the port is unreachable. Every check above can pass against a daemon started
days ago from a build nobody rebuilt, which is what happened for three days
(ADR-0037); the checks cannot see it, the identity can. It repeats neither the token nor the
endpoint: a diagnostic gets pasted into issues.

**Ownership acquisition** (ownership.ts:105–140):

1. Reject `win32` (ownership.ts:109)
2. Validate `owner` via `isDaemonOwner` (ownership.ts:110)
3. `lockPath = ${discoveryFile}.lock` (ownership.ts:111)
4. `ensurePrivateDirectory` — `mkdir 0700` + reject symlinks (ownership.ts:46–53)
5. Loop up to 8 attempts (ownership.ts:114–138):
   - `publishOwner` — create temp file `.{lock}.{hex}.tmp` at `0600`, write JSON, sync, then atomic `link` to `lockPath` (ownership.ts:84–103)
   - If `EEXIST`: `readOwner` with `O_NOFOLLOW` — if `ENOENT`, continue; if live PID, throw `"already-running"`; if dead PID, `rename` to stale path + `unlink` (ownership.ts:122–137)
6. Exhausted attempts → throw `"already-running"` (ownership.ts:139)

## Integration Points

**Consumed by:**

- `bin.ts` — shebang entry point for the `ide-bridge` binary (bin.ts:1–9)
- Tests import from `index.ts` barrel (index.ts:1–6), which re-exports `arguments`, `doctor`, `errors`, `ownership`, `paths`, `run-cli`

**Depends on:**

- `@ide-bridge/bridge-client` — `connectBridgeClient`, `readPrivateDiscoveryFile`, `AuthenticatedBridgeConnection`, `BridgeClientConfigurationError`, `BridgeClientConnectionError`, `BridgeClientHandshakeTimeoutError`, `BridgeClientProtocolViolationError`, `BridgeHandshakeRejectedError` (run-cli.ts:1–7, admin-client.ts:1–5)
- `@ide-bridge/bridge-daemon` — `IDEBPDaemonServer`, `StructuredLogger`, `createStderrJsonLineSink`, `generateAuthenticationToken`, `writePrivateDiscoveryFile`, `StructuredLogLevel`, `MAX_HEARTBEAT_INTERVAL_MS`, `MAX_MISSED_HEARTBEATS`, `compareProtocolVersions` (daemon-command.ts:4–11, doctor.ts:4–8, arguments.ts:1)
- `@ide-bridge/protocol` — `IDEBPDiscoveryFile`, `PROTOCOL_VERSION` (daemon-command.ts:12, doctor.ts:9)
- Node.js builtins: `fs/promises`, `fs` constants, `crypto`, `path`, `os`

**External boundaries:**

- Binary entry: `#!/usr/bin/env node` (bin.ts:1)
- Env var: `IDE_BRIDGE_DISCOVERY_FILE` (paths.ts:13)
- Default discovery path: `~/.ide-bridge/discovery.json` (paths.ts:16)
- Lock file path: `${discoveryFile}.lock` (ownership.ts:111)
- Discovery file permissions: `0600` (doctor.ts:51 validates; bridge-daemon `writePrivateDiscoveryFile` enforces)
- Lock directory permissions: `0700` (ownership.ts:47, 52)
- CLI flags: `--help`/`-h`, `--discovery-file <path>`, `--log-level <level>`, `--dashboard` (run-cli.ts:25–39 HELP text)
- Exit codes: 0 success, 1 operational error, 2 usage error (run-cli.ts:70, 79, 143)
- Output format: JSON lines — results on stdout, errors + daemon logs on stderr
- RPC methods called: `bridge/getStatus`, `bridge/listAdapters`, `workspace/list`, `workspace/getStatus`, `bridge/listSessions` (run-cli.ts:109, 119, 131; doctor.ts:66, 67, 76, 100)
- Request timeout: `CLI_REQUEST_TIMEOUT_MS = 5_000` (admin-client.ts:9)
- Client identity: `{name:"ide-bridge-cli", version:"0.0.0"}` (admin-client.ts:24)

## Common Gotchas

- **Windows is always rejected.** Both `runCli` (run-cli.ts:76–79) and `acquireDaemonOwnership` (ownership.ts:109) throw `platform-unsupported` on `win32`. No ACL-based ownership model exists.
- **`--log-level` is daemon-only.** Specifying it with any other command throws `CliUsageError("unexpected-argument")` (arguments.ts:81–83).
- **`--dashboard` is daemon-only.** Refused rather than ignored on other commands — silently accepting a flag that does nothing teaches the reader it did something (arguments.ts:86–88). When used with `daemon`, starts the read-only local dashboard surface (ADR-0035) and writes the URL to stdout in the ready JSON (daemon-command.ts:100), not to the structured log (ADR-0011).
- **Warnings don't fail doctor.** `ok` is `checks.every(({status}) => status !== "fail")` (doctor.ts:182). A `warn` (e.g., `no-adapter-registered`) is acceptable. Only `fail` makes the report non-ok.
- **Short-circuiting emits skip, not silence.** When discovery-file or port checks fail, downstream checks are explicitly pushed as `{status:"skip", detail:"prerequisite-unavailable"}` (doctor.ts:59–61, 136–138, 154) — they are not omitted from the report.
- **Discovery file removal is proof-bound.** All four fields (`endpoint`, `token`, `pid`, `startedAt`) must match the original before `unlink` (daemon-command.ts:46–52). On any mismatch, the file is left intact.
- **Ownership release is proof-bound.** `releaseDaemonOwnership` only unlinks if current `pid` and `startedAt` match the acquiring owner (ownership.ts:144–147). The `catch` block is silent — never delete ownership state that cannot be proven to belong to this process.
- **Stale lock recovery uses `rename`, not direct `unlink`.** The stale lock is renamed to a unique `.stale.{hex}` path first, then unlinked (ownership.ts:131–134) to avoid race conditions between concurrent acquire attempts.
- **`O_NOFOLLOW` prevents symlink attacks on the lock file.** `readOwner` opens with `O_RDONLY | O_NOFOLLOW` (ownership.ts:56) and validates no group/world permissions and correct uid before reading.
- **Token never appears in command output.** The daemon ready message includes only `pid` (daemon-command.ts:99). The dashboard URL (including its launch token) is written to stdout as `dashboard` field when `--dashboard` is passed (daemon-command.ts:100), never to the structured log (ADR-0011). Errors use stable `CliOperationalErrorCode` strings, never raw exception messages (run-cli.ts:147–151).
- **CLI process IS the daemon.** When running `ide-bridge daemon`, the CLI process starts `IDEBPDaemonServer` directly (daemon-command.ts:85). No separate daemon process is spawned — the CLI process blocks on SIGINT/SIGTERM (daemon-command.ts:102).
- **Daemon is foreground-only.** The daemon blocks on `shutdownSignal.promise` (daemon-command.ts:102). Process managers own backgrounding.
- **Lock acquisition has bounded retries.** `MAX_ACQUISITION_ATTEMPTS = 8` (ownership.ts:9). If all attempts encounter live or indeterminate owners, it throws `"already-running"` (ownership.ts:139).
- **Relative discovery paths are resolved against cwd.** `resolveDiscoveryFilePath` resolves non-absolute paths via `resolve(cwd, candidate)` (paths.ts:22–23), not against the home directory.
