# packages/bridge-client/src/discovery/

## Responsibility

This directory implements secure discovery-file reading for the IDE Bridge client. It reads a private discovery file from disk — containing the daemon's WebSocket endpoint URI, authentication token, and protocol metadata — while enforcing strict security constraints: symlink rejection, file ownership check, permission check, and size limits. It is the trust boundary that converts an opaque file path into a validated `IDEBPDiscoveryFile` object safe for use in a handshake.

## Design Patterns

- **Defense-in-Depth Validation** (`discovery-file.ts:17-25`): Multiple independent checks before the file content is even read — `O_NOFOLLOW` (symlink rejection), `isFile()` (not directory/device), mode check (`0o077` must be zero), UID ownership match, and size limit.
- **Over-Allocate-and-Verify Read** (`discovery-file.ts:27-34`): Allocates `MAX_DISCOVERY_FILE_BYTES + 1` bytes and reads in a loop; if the total exceeds the limit, the file is rejected. This prevents a file that is exactly at the boundary from passing by truncation.
- **Fail-Closed with Explicit Errors** (`discovery-file.ts:13-14`): On Windows, the function throws immediately because POSIX ACL/ownership validation is not implementable. There is no fallback or relaxed mode.

## Key Types

### `MAX_DISCOVERY_FILE_BYTES` (`discovery-file.ts:10`)

```typescript
export const MAX_DISCOVERY_FILE_BYTES = 16 * 1024; // 16 KiB
```

Upper bound on discovery file size. Enforced both via buffer allocation and post-read byte count verification.

### Return type: `IDEBPDiscoveryFile` (from `@ide-bridge/protocol`)

The parsed, validated discovery file object containing `endpoint`, `token`, `protocolVersion`, and other daemon metadata.

## Key Functions

### `readPrivateDiscoveryFile(filePath): Promise<IDEBPDiscoveryFile>` (`discovery-file.ts:12-51`)

The sole exported function. Security-validated reader for discovery files.

**Validation sequence** (all must pass):

1. **Platform check**: Throws on `win32` — ACL validation not implemented (`line 13-15`).
2. **Open with `O_RDONLY | O_NOFOLLOW`**: Rejects symlinks at the `open(2)` syscall level. If the path is a symlink, the OS returns `ELOOP` and `open` rejects (`line 17`).
3. **`stat()` the handle**: Confirms it is a regular file (`line 19-20`).
4. **Permission check**: `(metadata.mode & 0o077) !== 0` — group and world must have zero permissions. This enforces `0600` or stricter (`line 21`).
5. **Ownership check**: `metadata.uid !== process.getuid()` — file must be owned by the current user. Skipped if `process.getuid` is not a function (non-POSIX environments) (`line 22-24`).
6. **Size check (pre-read)**: `metadata.size > MAX_DISCOVERY_FILE_BYTES` — rejects oversized files before reading (`line 25`).
7. **Read loop**: Reads up to `MAX_DISCOVERY_FILE_BYTES + 1` bytes in chunks; re-checks total after read (`line 27-34`).
8. **JSON parse**: Parses the UTF-8 content as JSON; throws on invalid JSON (`line 36-41`).
9. **Schema validation**: `parseIDEBPDiscoveryFile(value)` validates against the IDEBP discovery file JSON Schema (`line 43`).
10. **Protocol version check**: `discovery.protocolVersion !== PROTOCOL_VERSION` — rejects incompatible versions (`line 44-45`).

**Resource safety**: The file handle is always closed via `finally` (`line 48-50`), even on error paths.

## Data & Control Flow

```
Caller (connectBridgeClientFromDiscoveryFile)
  └─ readPrivateDiscoveryFile(filePath)
       ├─ Platform check (win32 → throw)
       ├─ open(filePath, O_RDONLY | O_NOFOLLOW)         ← symlink rejection
       │    └─ handle (file descriptor)
       ├─ handle.stat()
       │    ├─ isFile()?           ← no → throw "not a regular file"
       │    ├─ (mode & 0o077) === 0? ← no → throw "permissions too broad"
       │    ├─ uid === getuid()?   ← no → throw "not owned by current user"
       │    └─ size <= 16KiB?      ← no → throw "too large"
       ├─ read loop (max 16385 bytes)
       │    └─ bytesRead > 16KiB?  ← yes → throw "too large"
       ├─ JSON.parse(bytes)
       │    └─ invalid?            ← throw "not valid JSON"
       ├─ parseIDEBPDiscoveryFile(value)                 ← JSON Schema validation
       │    └─ invalid?            ← throw (from parseIDEBPDiscoveryFile)
       ├─ discovery.protocolVersion === PROTOCOL_VERSION?
       │    └─ no?                 ← throw "incompatible"
       └─ return discovery (IDEBPDiscoveryFile)
            └─ finally: handle.close()
```

## Integration Points

- **Consumed by**: `packages/bridge-client/src/connection/connect.ts` via `connectBridgeClientFromDiscoveryFile` (`connect.ts:27, 199`).
- **Depends on**:
  - `node:fs` — `constants` (`O_RDONLY`, `O_NOFOLLOW`).
  - `node:fs/promises` — `open`.
  - `@ide-bridge/protocol` — `PROTOCOL_VERSION`, `parseIDEBPDiscoveryFile`, `IDEBPDiscoveryFile` type.
- **External boundaries**:
  - File path on local filesystem (provided by caller, typically a path to a discovery file in a well-known location).
  - No network, no environment variables, no configuration files.

## Common Gotchas

- **`O_NOFOLLOW` is a syscall-level symlink rejection**. If the final path component is a symlink, `open(2)` fails with `ELOOP`. This is stronger than a post-`stat` `isSymbolicLink()` check because it eliminates the TOCTOU window between `stat` and `open` (`discovery-file.ts:17`).
- **The permission check uses `mode & 0o077`** — this means only owner permissions are allowed. A file with mode `0644` (group-readable) will be rejected. The file must be `0600` or stricter (`discovery-file.ts:21`).
- **The ownership check is conditional on `typeof process.getuid === "function"`**. On platforms where `getuid` is unavailable, the ownership check is silently skipped. This is the only security check that is platform-conditional (`discovery-file.ts:22`).
- **Windows is explicitly unsupported**. The function throws immediately on `win32` without attempting a relaxed read. There is no fallback (`discovery-file.ts:13-15`).
- **The buffer is over-allocated by 1 byte** (`MAX_DISCOVERY_FILE_BYTES + 1`). This ensures that a file of exactly `MAX_DISCOVERY_FILE_BYTES + 1` bytes is detectable — if only `MAX_DISCOVERY_FILE_BYTES` bytes were allocated, a file of exactly that size would read successfully and pass, while a file one byte larger would read `MAX_DISCOVERY_FILE_BYTES` bytes and also appear to pass. The `+1` makes the boundary deterministic (`discovery-file.ts:27, 34`).
- **`parseIDEBPDiscoveryFile` may throw its own error** distinct from the JSON parse error. The function does not wrap this error — callers may see protocol-level validation errors rather than generic "discovery file" errors (`discovery-file.ts:43`).
- **The protocol version check happens after schema validation**. A discovery file with an incompatible `protocolVersion` but otherwise valid structure will pass schema validation and fail at the version check (`discovery-file.ts:44`).
