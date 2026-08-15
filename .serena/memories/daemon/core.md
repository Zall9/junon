# Daemon, client, and security invariants

- Daemon listens only on `127.0.0.1`/optional `::1`; no public-listen option.
- Authentication token: cryptographically random >=256 bits; never logged. Discovery file is atomic/private, `0600` Unix, no symlink traversal.
- Native Windows discovery ownership/ACL is an explicit unsupported gap until implemented; never approximate Unix permissions.
- Shared bridge client owns discovery reading, handshake, typed RPC, cancellation, inbound adapter dispatch, physical sessions, and reconnect. IDE adapters must not duplicate JSON-RPC.
- Each reconnect creates a new physical session. Pending work fails and is never replayed; registration state is rebuilt before connection publication.
- Daemon registry is authoritative for role, adapter, workspace, current epoch, trust, capabilities, and adapter connection.
- Consumer request IDs are remapped to private route IDs. Cancellation and response ownership remain connection/session-scoped.
- Consumer symbol handles are checked against current adapter/session and epoch before routing.
- Adapter document/symbol/edit DTOs are independently checked for workspace/root/epoch/URI and nested handle authority; schema validity alone is insufficient.
- Plan/undo public IDs are daemon-owned and never expose adapter-private identity. Apply/discard/undo enforce trust, ownership, expiration, preconditions, one-shot consumption, and response integrity.
- Invalid provider authority generally returns safe `PROVIDER_FAILED` and closes the offending adapter.
- Close reasons must fit **123 bytes** (RFC 6455 leaves 123 of 125 after the status code). Over the limit `close()` throws instead of truncating, so the session stays open and the offending adapter is never disconnected — silently voiding the invariant above. `clampCloseReason` enforces it on code-point boundaries; keep reasons short at the source anyway. See `mem:ide-bridge/verification-method`.
- Logs use structured closed events, bounded volume, HMAC request correlation, monotonic duration, and payload-free fields. Sink failure must not crash protocol processing.
- CLI doctor is read-only; it never repairs/removes state or prints discovery path, endpoint, or token.
- Key modules: `packages/bridge-daemon/src/routing/`, `session/`, `security/`, `plan/`, `observability/`; `packages/bridge-client/src/connection/`.