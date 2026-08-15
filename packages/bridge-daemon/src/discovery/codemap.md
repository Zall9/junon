# packages/bridge-daemon/src/discovery/

## Responsibility

Writes the IDEBP discovery file — a JSON file on disk containing the daemon's endpoint URI, authentication token, PID, protocol version, and start timestamp. The file is written atomically (temp file + rename) with restrictive `0600` permissions, on Unix only. Clients (consumers/adapters) read this file to locate and authenticate with the daemon.

## Design Patterns

- **Atomic Write**: Write to a temp file (`.basename.randomhex.tmp`), `fsync`, then `rename` to the final path (`discovery-file.ts:58-67`). This prevents partial reads if the process crashes mid-write.
- **Defense in Depth**: Multiple security checks: directory must be a real directory (not symlink, `:47`), directory permissions set to `0o700` (`:50`), file created with `0o600` via `O_WRONLY | O_CREAT | O_EXCL` (`open` with `"wx"` flag, `:58`), final file permissions verified after rename (`:69`).
- **Platform Guard**: Explicit rejection on Windows (`discovery-file.ts:25-27`) because `0600` ACLs are not implemented for Windows.
- **Loopback Assertion**: `assertLoopbackDiscoveryEndpoint` (`discovery-file.ts:18`) delegates to `assertIDEBPLoopbackEndpoint` from `@ide-bridge/protocol` to verify the endpoint is `ws://127.0.0.1:*` or `ws://[::1]:*`.

## Key Types

- `WriteDiscoveryFileOptions` (`discovery-file.ts:10`): `filePath: string`, `endpoint: string`, `token: string`, `pid?: number`, `startedAt?: Date`.
- `IDEBPDiscoveryFile` (from `@ide-bridge/protocol`): The JSON structure written to disk — `protocolVersion`, `endpoint`, `token`, `pid`, `startedAt`.

## Key Functions

- `writePrivateDiscoveryFile(options): Promise<IDEBPDiscoveryFile>` (`discovery-file.ts:22`): Main entry point. Validates platform, endpoint, and token. Creates parent directory (`0o700`), writes temp file (`0o600`), `fsync`s, renames to final path, verifies final permissions. On error, cleans up temp or published file.
- `assertLoopbackDiscoveryEndpoint(endpoint): void` (`discovery-file.ts:18`): Thin wrapper around `assertIDEBPLoopbackEndpoint` from the protocol package. Throws if the endpoint is not a loopback WebSocket URL.

## Data & Control Flow

1. Caller provides `filePath`, `endpoint` (e.g. `ws://127.0.0.1:54321/rpc`), `token` (base64url), optional `pid` and `startedAt`.
2. Platform check: if `win32` → throw.
3. `assertLoopbackDiscoveryEndpoint(endpoint)` → validates endpoint URI.
4. `isAuthenticationToken(token)` → validates token format.
5. PID validation: must be a positive safe integer (defaults to `process.pid`).
6. Build `IDEBPDiscoveryFile` object: `{ protocolVersion: PROTOCOL_VERSION, endpoint, token, pid, startedAt }`.
7. `mkdir(dirname(filePath), { recursive: true, mode: 0o700 })`.
8. `lstat(directory)` → reject if symlink or not a directory.
9. `chmod(directory, 0o700)` — enforce even if directory already existed.
10. Generate temp path: `.basename.randomhex.tmp` in the same directory.
11. `open(tempPath, "wx", 0o600)` — `O_CREAT | O_EXCL` prevents symlink races.
12. `writeFile(JSON.stringify(discovery, null, 2) + "\n")` → `sync()` → `close()`.
13. `rename(tempPath, filePath)` → atomic publish.
14. `chmod(filePath, 0o600)` → `stat` → verify mode is `0o600`.
15. On any error: `unlink` temp file (or published file if `published === true`), re-throw.

## Integration Points

- **Consumed by**: Daemon CLI / entry point that starts the server and writes the discovery file for clients to find.
- **Depends on**: `@ide-bridge/protocol` (`assertIDEBPLoopbackEndpoint`, `PROTOCOL_VERSION`, `IDEBPDiscoveryFile` type), `../security/authentication-token.js` (`isAuthenticationToken`), `node:crypto` (`randomBytes`), `node:fs/promises` (`chmod`, `lstat`, `mkdir`, `open`, `rename`, `stat`, `unlink`), `node:path` (`basename`, `dirname`, `join`).
- **External boundaries**: Filesystem write to `options.filePath`. Parent directory created with `0o700`. File written with `0o600`. Not available on Windows.

## Common Gotchas

- Windows is explicitly unsupported (`discovery-file.ts:25-27`) — the function throws immediately on `process.platform === "win32"`. This is by design; Unix ACL semantics are required for the security model.
- The `"wx"` flag in `open()` (`discovery-file.ts:58`) is `O_WRONLY | O_CREAT | O_EXCL` — it fails if the temp file already exists, preventing symlink attacks on the temp path.
- The directory is `lstat`-ed (not `stat`) to detect symlinks (`discovery-file.ts:46`) — `lstat` does not follow symlinks, so a symlinked directory is rejected.
- `chmod` is called on both the directory (`:50`) and the final file (`:68`) after rename — the rename may preserve the temp file's permissions, but `chmod` enforces `0o600` regardless.
- The final permission check (`:69-70`) reads back the mode and throws if it's not exactly `0o600` — this catches filesystems that don't honor `chmod` (e.g., FAT32).
- On error after the file has been published (`published === true`), the published file is unlinked (`:73`) to prevent clients from reading a partially valid discovery file.
- The discovery file contains the **plaintext authentication token** — the file's `0600` permissions are the primary protection. Never log the file contents (per AGENTS.md §4).
- `randomBytes(8)` for the temp file suffix (`:54`) gives 64 bits of randomness — sufficient to avoid temp file collisions in the same directory.
