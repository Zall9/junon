# Phase 2 token and discovery increment audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The authentication-token and local discovery-file
foundation is internally consistent and ready to support the loopback transport and first-message
handshake processor. This is not a Phase 2 completion verdict: transport, authenticated session
creation, routing, cancellation, heartbeat, plan storage, CLI health checks, and reconnection remain
pending.

## Scope

- authentication-token generation, representation validation, and comparison
- canonical discovery-file wire schema, fixtures, and generated TypeScript type
- daemon discovery-file publication on Unix
- shared protocol runtime parsing and endpoint validation
- bridge-client discovery-file loading on Unix
- CI ordering required by generated inter-package declarations
- secret-safe error behavior and local file-system attack surfaces

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-DISC-AUD-01 | High | The discovery endpoint schema accepted five-digit ports above 65535 while daemon semantics rejected them. | Encoded the full TCP range in the canonical schema, retained shared semantic validation as defense in depth, and added an invalid `99999` fixture. |
| P2-DISC-AUD-02 | Medium | Endpoint checks were initially daemon-local, allowing daemon and client interpretation to drift. | Centralized loopback WebSocket validation in `@ide-bridge/protocol`; both runtime discovery parsing and the daemon writer use it. |
| P2-DISC-AUD-03 | Medium | The token runtime accepted values longer than the schema's 512-character maximum. | Aligned the daemon validator with the canonical `43..512` range and added rejection coverage. |
| P2-DISC-AUD-04 | High | A symlink used as the immediate discovery directory could be followed and have its target permissions changed. | The writer now checks the created/resolved directory with `lstat` and refuses symbolic links before `chmod` or publication. |
| P2-DISC-AUD-05 | Medium | A file could grow after its metadata size check and make the client perform an unbounded `readFile`. | Replaced it with a fixed 16 KiB + 1 byte read loop; oversized or concurrently grown files are rejected. |
| P2-DISC-AUD-06 | Medium | A clean CI typecheck could consume missing or stale declarations from dependency packages. | The TypeScript CI job now builds all workspace packages before strict typechecking. |

No unresolved correctness finding remains in this increment. Windows is intentionally rejected by
both reader and writer until restricted owner-only ACL behavior is implemented and tested.

## Security invariants verified

- generated tokens contain 32 CSPRNG bytes and use unpadded base64url
- comparisons operate on fixed-size SHA-256 digests through `timingSafeEqual`
- discovery endpoints are only uncredentialed `ws://127.0.0.1:<port>/rpc` or
  `ws://[::1]:<port>/rpc`, with ports in `1..65535`
- Unix publication uses an exclusive `0600` temporary file, `fsync`, atomic rename, and final mode
  verification inside a `0700` non-symlink directory
- client loading uses `O_NOFOLLOW`, regular-file, owner, permission, and bounded-size checks
- parser errors expose only schema paths/keywords and never echo token or file contents

## Node 24.15.0 evidence

```text
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 14 files, 71 tests
pnpm protocol:fixtures            # 161 entries, 32 fixtures
pnpm protocol:generate:check
```

The GitHub Actions YAML also parses locally. Execution on a hosted runner remains an operational
risk until a real workflow run is available.

## Next audited boundary

The next increment is the loopback-only WebSocket server and pre-dispatch handshake state machine.
It must be audited before request routing is enabled, particularly for first-message enforcement,
generic authentication failures, version intersection, role/topology binding, message size limits,
and creation of no session on failure.
