# packages/bridge-daemon/src/security/

## Responsibility

Authentication token generation, validation, and timing-safe comparison, plus re-export of the canonical workspace-root URI containment rule. Tokens are 256-bit (32-byte) CSPRNG values encoded as unpadded base64url strings, compared via SHA-256 hashing with `timingSafeEqual` to prevent timing attacks and length leakage. URI containment is defined in the protocol package (`@ide-bridge/protocol`) so that adapters and the daemon apply exactly the same rule byte-for-byte; `workspace-uri.ts` re-exports it here to keep the daemon's security surface addressable from one module.

## Design Patterns

- **Constant-Time Comparison**: `authenticationTokensEqual` (`authentication-token.ts:20`) hashes both tokens with SHA-256 before comparing with `timingSafeEqual`. This produces fixed-size 32-byte digests, preventing length-based timing side channels.
- **Wire Validation**: `isAuthenticationToken` (`authentication-token.ts:12`) validates the wire representation before any comparison, rejecting malformed tokens early with a regex pattern.
- **CSPRNG Generation**: `generateAuthenticationToken` (`authentication-token.ts:7`) uses `node:crypto.randomBytes` (not `Math.random`).
- **Fail-Closed URI Containment**: `isUriWithinWorkspaceRoot` returns `false` for any parse failure, malformed input, or containment violation. It never throws. **The implementation lives in `@ide-bridge/protocol` (`packages/protocol/src/workspace-uri.ts`)** and `workspace-uri.ts` re-exports it: an adapter whose containment rule is looser than the daemon's would emit results the daemon rejects as a policy violation, so both sides must share one definition (ADR-0017). The re-export is a single 6-line file (`workspace-uri.ts:1-6`).
- **Authorization-Only Normalization**: `normalizedUriSegments` (`workspace-uri.ts:1` in protocol) percent-decodes and resolves dot segments for authorization comparison only — the original URI remains the value forwarded on the wire.

## Key Types

- `AUTHENTICATION_TOKEN_BYTES` (`authentication-token.ts:3`): `32` — 256 bits of entropy.
- `TOKEN_PATTERN` (`authentication-token.ts:4`): `/^[A-Za-z0-9_-]{43,512}$/u` — base64url charset, minimum 43 chars (32 bytes base64url-encoded = 43 chars), maximum 512.

## Key Functions

- `generateAuthenticationToken(): string` (`authentication-token.ts:7`): Returns `randomBytes(32).toString("base64url")` — a 43-character unpadded base64url string with 256 bits of entropy.
- `isAuthenticationToken(value: unknown): value is string` (`authentication-token.ts:12`): Type guard. Checks `typeof value === "string"` and `TOKEN_PATTERN.test(value)`.
- `authenticationTokensEqual(expected: string, supplied: unknown): boolean` (`authentication-token.ts:20`): Validates both tokens via `isAuthenticationToken`, then SHA-256 hashes both, compares digests with `timingSafeEqual`. Returns `false` if either token is invalid (not an error throw).
- `isUriWithinWorkspaceRoot(documentUri: string, rootUri: string): boolean` (`workspace-uri.ts:6` re-export; implementation at `packages/protocol/src/workspace-uri.ts:36-57`): Parses both URIs via `new URL()`. Compares `protocol`, `username`, `password`, `host`, `search`, `hash` for exact equality. Normalizes both pathnames via `normalizedUriSegments`. Returns `true` only if every root segment matches the corresponding document segment (root is a prefix). Fail-closed: any parse failure or `undefined` segments → `false`.
- `normalizedUriSegments(pathname: string): string[] | undefined` (`packages/protocol/src/workspace-uri.ts:10-32`): Percent-decodes the pathname via `decodeURIComponent`. Rejects NUL bytes (`\u0000`) and backslashes (`\\`). Resolves dot segments: `..` pops (returns `undefined` if popping above root), empty/`.` skipped, other segments pushed. Returns `undefined` on decode failure or traversal escape.

## Data & Control Flow

**Token flow**:

1. `generateAuthenticationToken()` → `randomBytes(32)` → `.toString("base64url")` → 43-char string.
2. Token stored as `expectedToken` in `HandshakeProcessorOptions` and `LoopbackWebSocketServerOptions`.
3. On handshake: `HandshakeProcessor.process()` calls `authenticationTokensEqual(this.#expectedToken, request.params.authentication.token)`.
4. Both tokens validated by `isAuthenticationToken` → SHA-256 hashed → `timingSafeEqual` on 32-byte digests → `true/false`.
5. Invalid supplied token (wrong format/length) → `false` (no throw).

**URI containment flow**:

1. Caller invokes `isUriWithinWorkspaceRoot(documentUri, rootUri)` with two wire URI strings.
2. `new URL()` parses both. Any parse failure → `false`.
3. Component comparison: `protocol`, `username`, `password`, `host`, `search`, `hash` must all match exactly.
4. `normalizedUriSegments` percent-decodes and resolves dot segments for both pathnames. Any failure → `false`.
5. Root segments checked as prefix of document segments. If root is `["a", "b"]` and document is `["a", "b", "c"]` → `true`. If root is `["a", "b"]` and document is `["a", "b"]` → `true` (document IS the root). If root is `["a", "b"]` and document is `["a", "c"]` → `false`.
6. Original URIs are never modified — normalization is for authorization comparison only.

## Integration Points

- **Consumed by**:
  - `HandshakeProcessor` (`session/handshake-processor.ts`) — constructor validates the expected token; `process()` compares with the supplied token.
  - `InMemoryEditStore` (`plan/in-memory-edit-store.ts`) — uses `isUriWithinWorkspaceRoot` for document URI containment validation.
  - `ApplicationRouter` (`routing/application-router.ts:37`) — imports `isUriWithinWorkspaceRoot` for `#assertWorkspaceDocument` and `#assertWorkspaceUri` validation.
- **Depends on**: `node:crypto` (`createHash`, `randomBytes`, `timingSafeEqual`) for `authentication-token.ts`. `workspace-uri.ts` depends on `@ide-bridge/protocol` (single re-export). The protocol implementation has zero external dependencies (uses global `URL`, `decodeURIComponent`).
- **External boundaries**: No I/O. Pure functions. Token format is base64url (RFC 4648 §5, no padding); URI values are returned and forwarded unchanged by their callers.

## Common Gotchas

- **`workspace-uri.ts` is now a 6-line re-export** (`workspace-uri.ts:1-6`) — the containment logic moved to `@ide-bridge/protocol` so adapters and the daemon share one implementation. Do not re-implement containment logic here; import from `@ide-bridge/protocol` or re-export it.
- `authenticationTokensEqual` returns `false` (not an error) if either token fails `isAuthenticationToken` validation (`authentication-token.ts:21`) — callers must check the boolean, not catch exceptions.
- SHA-256 hashing before comparison is intentional: it normalizes token lengths so `timingSafeEqual` receives equal-length buffers (required by `timingSafeEqual`, which throws on length mismatch).
- The `expected` token is also validated by `isAuthenticationToken` (`authentication-token.ts:21`) — if the daemon was misconfigured with an invalid token, the comparison returns `false` for all supplied tokens.
- `TOKEN_PATTERN` minimum of 43 characters corresponds exactly to 32 bytes base64url-encoded without padding (`authentication-token.ts:4`). The maximum of 512 is a safety bound, not a tight constraint.
- `normalizedUriSegments` rejects backslashes (`packages/protocol/src/workspace-uri.ts:14-15`) — backslashes are not valid URI path separators and could be used for path confusion attacks on Windows-style paths.
- `normalizedUriSegments` returns `undefined` if `..` pops above the root (`packages/protocol/src/workspace-uri.ts:19-21`) — this is a traversal-escape rejection, not a normalization.
- `isUriWithinWorkspaceRoot` compares full URI components including `search` and `hash` (`packages/protocol/src/workspace-uri.ts:41-43`) — a document URI with a query string different from the root's will fail containment, even if the path is within the root.
- `isUriWithinWorkspaceRoot` is fail-closed (`packages/protocol/src/workspace-uri.ts:55-57`) — the outer `catch` returns `false` for any unexpected error, including `URL` constructor failures.
- `authentication-token.ts` has zero internal state and depends only on `node:crypto`.
