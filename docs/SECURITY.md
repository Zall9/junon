# IDE Bridge — Security

> Reflects `TASK.md` §26. Does not reduce scope.

---

## 1. Threat Model

| # | Threat | Description | Mitigation |
|---|--------|-------------|------------|
| T1 | Malicious local process | A non-authorized process on the same machine attempts to connect to the daemon | Loopback-only bind, token authentication (>= 256 bits), unauthenticated connections refused |
| T2 | Token theft | Attacker reads the discovery file to obtain the auth token | Discovery file with most restrictive permissions (`0600` Unix), `doctor` checks permissions, token never logged |
| T3 | Accessible discovery file | File created with world-readable permissions | File created with `0600` (Unix) / restricted ACL (Windows); `doctor` verifies; refuse to start if permissions are too permissive |
| T4 | Publicly exposed WebSocket | Daemon accidentally listens on `0.0.0.0` | Hardcoded loopback-only bind; no configuration option for public listen in MVP; test that non-loopback connection is refused |
| T5 | Compromised IDE extension | Malicious extension co-located in the IDE attempts to interact with the daemon | Token authentication; extension only receives token via discovery file; no arbitrary command execution methods |
| T6 | Malicious MCP client | A rogue agent connects and attempts destructive operations | Capability model limits exposed operations; workspace trust enforcement; `PERMISSION_DENIED` for unauthorized writes |
| T7 | Wrong workspace operation | Operation routed to the wrong workspace | Routing by `adapterId`/`workspaceId`/`sessionId`; never cross-route without explicit decision |
| T8 | Stale document modification | Edit applied to a document that has changed since preparation | Revision preconditions (editorVersion, contentHash, workspaceEpoch); `STALE_DOCUMENT` error; plan invalidation on document change |
| T9 | Plan replay | Same plan applied twice | Plans are non-reusable after application; atomic consumption; `PLAN_EXPIRED` or `PLAN_NOT_FOUND` on second apply |
| T10 | Source content leak in logs | File contents or replacement text appear in logs | Structured logging with redaction; never log secrets, full file contents, full replacement text, or sensitive diagnostic data |
| T11 | Local denial of service | Flooding the daemon with messages | Message size limits, timeouts, rate limiting, session expiration |
| T12 | Malformed JSON messages | Invalid or deeply nested JSON payloads | JSON-RPC 2.0 validation; message size limits; schema validation on all incoming messages |
| T13 | URI path traversal | Malicious URI attempts to escape workspace boundaries | URI validation; reject URIs that resolve outside workspace roots; no file access outside workspace without explicit permission |
| T14 | Symlinks | Symlink within workspace points outside workspace | Resolve and validate symlink targets; reject if target escapes workspace |
| T15 | Untrusted workspace | Operations in a workspace the user has not trusted | Workspace trust enforcement: safe reads allowed, writes blocked, `PERMISSION_DENIED` on write; trust status announced in capabilities |

---

## 2. Daemon Restrictions

The daemon must expose **no method** that allows:

- Executing an arbitrary shell command.
- Executing an arbitrary IDE command.
- Evaluating arbitrary JavaScript or Kotlin code.
- Accessing a file outside a workspace without explicit permission.
- Silently disabling trust controls.

---

## 3. Authentication

- Token: at least 256 bits, generated with `crypto.randomBytes` (Node.js) or equivalent cryptographically secure RNG.
- Token written to discovery file only.
- Token encoded as unpadded base64url and sent with `authentication.method: "token"` in the first
  `bridge/handshake` JSON-RPC request after the WebSocket connection opens.
- Unauthenticated connections are closed immediately.
- Token is never logged, never included in error responses, never sent over non-loopback transport.
- Before handshake success, the daemon validates but does not dispatch any other IDEBP request or
  notification. Token comparison is constant-time. Every failed handshake creates no session and
  closes the connection after at most one safe, generic error response.
- Idle unauthenticated connections expire after five seconds by default; the limit can only be
  configured downward. Messages pipelined before the handshake response are never dispatched.
- The shared client refuses WebSocket redirects, disables compression, bounds incoming messages,
  applies a four-second overall connection/handshake timeout, and validates response schema,
  correlation ID, role, and protocol version before exposing a session. Rejection and protocol
  errors never include daemon payloads or authentication values.
- After authentication, one daemon-wide heartbeat interval sends empty WebSocket ping frames.
  Quiet healthy clients answer automatically; application traffic or pong resets the session's
  bounded missed-heartbeat count. Exhaustion closes only that session and invokes the same
  route/plan/adapter cleanup path as other connection loss. Interval and miss threshold have hard
  bounds, and close notifications expose only a canonical reason, never a raw socket reason.

---

## 4. Discovery File

```json
{
  "protocolVersion": "0.1.0",
  "endpoint": "ws://127.0.0.1:41731/rpc",
  "token": "<unpadded-base64url-token-of-at-least-32-random-bytes>",
  "pid": 12345,
  "startedAt": "2026-08-01T12:00:00Z"
}
```

- Created with `0600` permissions on Unix.
- On Windows, restricted ACL (owner only).
- Location: user-local directory (e.g., `~/.ide-bridge/discovery.json` or platform equivalent).
- `doctor` CLI command verifies permissions and warns if too permissive.
- Daemon refuses to start if the discovery file is world-readable.

Current Phase 2 implementation status: Unix writing is atomic through a private temporary file,
forces `0700` on the dedicated parent directory and `0600` on the published file, and refuses a
symlink as the immediate discovery directory. The shared client opens with `O_NOFOLLOW`, requires a
regular owner-only file owned by the current user, and bounds reads to 16 KiB. Windows is explicitly
rejected until owner-only ACL creation and validation are implemented; it is not approximated with
Unix permission checks.

The CLI additionally coordinates one foreground daemon per discovery path with an atomically
published `0600` sibling ownership file. A live owner prevents replacement; a valid dead owner is
renamed away atomically before recovery, so concurrent starters still have one winner. Clean
shutdown removes discovery only if endpoint, token, PID, and start time still match the current
daemon. `doctor` is read-only, never repairs permissions or removes ownership state, and never
prints the discovery path, endpoint, or token in failure records (ADR-0012).

The VS Code extension's local Unix auto-start invokes a bundled CLI child directly through the
extension-host Node runtime, never through a shell or PATH lookup. It starts only when discovery is
absent or already passes private-file validation, retains the exact child handle, and stops only that
owned process. Manual endpoint mode still takes authentication from the private discovery file and
disables auto-start; malformed existing discovery state is never overwritten (ADR-0014).

VS Code document routes never convert protocol URIs through `fsPath` or bypass VS Code filesystem
providers. The adapter requires exact URI serialization and `getWorkspaceFolder` ownership before
using `openTextDocument`. The daemon independently validates the routed workspace, exact requested
URI, registered root, current epoch, and URI containment for document results and events. Invalid
adapter documents fail closed without forwarding source content (ADR-0015).

VS Code symbol results are bounded before recursive schema validation. The daemon independently
checks every nested handle's adapter, physical session, unique ID, and current epoch, plus every
locator's exact requested URI and registered-root containment. Invalid symbol trees return a safe
`PROVIDER_FAILED` and close the adapter without forwarding provider data (ADR-0016).

---

## 5. Transport Security

- **MVP:** Loopback WebSocket (`ws://`). No TLS needed on loopback.
- No public network exposure. No configuration option to enable public listen.
- The implemented daemon server binds an ephemeral port on `127.0.0.1`, accepts only `/rpc`,
  disables WebSocket compression, enforces a hard 10 MiB maximum payload configurable only
  downward, and rechecks the peer address before handshake processing.
- Transport abstraction allows future: Unix domain socket, Windows named pipe, authenticated tunnel.
- No application-level encryption over local transport in MVP (deferred per TASK.md §29).

Authenticated routing follows ADR-0006. Adapter and workspace identifiers are accepted only when
they form one live session-owned hierarchy. Consumer request IDs are rewritten per hop because IDs
are scoped to their WebSocket; cancellation lookup includes the originating session. Symbol handles
must match the current workspace adapter and adapter session before forwarding.
Prepare/apply/discard/undo methods are intercepted by a bounded in-memory store: public plan and undo IDs are cryptographically
random, consumer-session scoped, workspace scoped, expiry bounded, and one-shot. Internal adapter
IDs remain reserved until the routed operation settles. Apply and undo additionally require a
trusted workspace.

Adapter inbound dispatch follows ADR-0008. The shared client exposes no raw-message handler: only
the thirteen routed methods may be registered, and returned results or declared normalized errors
are validated against the originating method. Capacity counts the actual handler promise until it
settles, even after timeout or cancellation, so an uncooperative handler cannot create hidden
unbounded work. Unexpected exceptions and invalid returns are reduced to a generic
`PROVIDER_FAILED` response without leaking exception text.

Client reconnection follows ADR-0009. Every attempt rereads the private discovery file and repeats
permission, ownership, loopback, version, authentication, and runtime validation. Backoff is capped
and jittered to prevent a retry storm. Pending requests, writes, plans, undo tokens, cancellations,
and other session-bound values are never queued or replayed after uncertain transport loss. Adapter
restoration is bounded and completes before the new session is published.

---

## 6. Log Redaction

Structured logs use the closed catalogue in ADR-0011. They include level, component, canonical
event/result, generated session ID when relevant, monotonic duration, and a process-local HMAC
correlation value instead of a raw peer-controlled request ID.

Never logged:
- Authentication secret / token.
- Full file contents.
- Full replacement text in edits.
- Sensitive diagnostic data (paths, user data in diagnostic messages must be redacted).

No generic message/context or raw `Error` crosses the logging boundary. Records have a fixed small
field set, emission is bounded per monotonic one-second window, and synchronous sink failures are
contained without recursive logging. The daemon library is silent unless its process owner supplies
a structured sink explicitly.

Daemon tests pass the real authentication token as a valid JSON-RPC request ID and attach source,
replacement, and diagnostic-shaped values to an invalid request; none appears in captured output.

---

## 7. Plan Security

- Plans are bound to adapter, session, and workspace.
- Plans expire automatically (configurable TTL).
- Plans are non-reusable: atomic consumption prevents double-apply.
- Plans invalidated on relevant document changes.
- Plans discarded explicitly via `workspace/discardPlan`.
- `workspace/applyPlan` checks: expiration, session, workspace, all preconditions, permissions, revisions before applying.

---

## 8. URI Safety

- All URIs validated against workspace root boundaries.
- Path traversal attempts (`../`) rejected.
- Symlink targets resolved and validated.
- No URI-to-path conversion without explicit mapper.
- Non-local URIs preserved without modification.

---

## 9. CI Security

- Secret detection step in CI (scan for tokens, keys, passwords in staged files).
- No package publication or release step.
- CI is non-destructive (no pushes, no commits, no deployments).

---

## 10. Conformance Security Scenarios

Mandatory security tests from TASK.md §22:

- Non-local connection refused.
- Missing token rejected.
- Discovery file too permissive → `doctor` warning.
- Oversized message rejected.
- No secret data in logs.
