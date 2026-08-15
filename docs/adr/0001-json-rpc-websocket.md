# ADR-0001 — JSON-RPC 2.0 over WebSocket with Loopback Authentication

## Status

Accepted

## Context

IDEBP needs a transport that:

1. Supports bidirectional communication (requests, responses, notifications).
2. Works on Linux and macOS for the MVP.
3. Is available in both Node.js (daemon) and Kotlin (JetBrains plugin).
4. Supports connection lifecycle (heartbeat, reconnection, cancellation).
5. Is familiar to the target audience (LSP uses JSON-RPC).
6. Can be abstracted for future transport alternatives (Unix domain socket, Windows named pipe, tunnel).

The transport must be secure by default: loopback-only, authenticated, no public exposure.

## Decision

Use **JSON-RPC 2.0 over WebSocket** as the IDEBP transport.

### Daemon transport

- The daemon listens on `127.0.0.1` and/or `::1` only.
- Dynamic port by default (ephemeral range).
- WebSocket subprotocol negotiation is not required; the first application message is the
  `bridge/handshake` JSON-RPC request defined below.
- Connection is stateful: a session is established at handshake.

### Authentication and discovery

- The daemon generates a token of at least 256 bits using a cryptographically secure random number generator (`crypto.randomBytes(32)` in Node.js, `SecureRandom` in Kotlin).
- The token, endpoint, protocol version, daemon PID, and start time are written to a private discovery file.
- Discovery file permissions: `0600` on Unix, restricted ACL on Windows.
- The discovery token is 32 cryptographically random bytes encoded as unpadded base64url (43
  characters). Longer base64url tokens remain compatible up to the protocol maximum of 512
  characters.
- The client reads the discovery file, extracts the token and endpoint, and sends the token using
  `authentication.method: "token"` in the first `bridge/handshake` request after the WebSocket
  connection opens.
- Unauthenticated connections are closed immediately.
- The token is never logged.

### Session handshake

`bridge/handshake` is the only application message accepted before a session is established. It is
a request, not a notification, because the client must receive the selected protocol version and
session identifier before continuing. Both adapters and consuming clients use it; `ide/register`
remains an adapter-only lifecycle method invoked after a successful handshake.

The request declares the requested session role (`adapter` or `consumer`), an inclusive protocol
version range, the client topology, and client identity. The canonical wire schemas are:

- `packages/protocol/schemas/bridge/handshake-request.schema.json`
- `packages/protocol/schemas/bridge/handshake-response.schema.json`
- `packages/protocol/schemas/bridge/handshake-error-response.schema.json`

The daemon processes a new connection in this order:

1. Enforce the frame/message-size limit and parse one JSON value.
2. Recognize a JSON-RPC request whose method is `bridge/handshake`; every other envelope or method
   is `INVALID_REQUEST`. Do not dispatch any IDEBP method or notification before authentication.
3. Validate against the complete `bridge/handshake` request schema. When the recognizable request's
   only invalid portion is absent or malformed authentication, classify it as the same generic
   `AUTHENTICATION_FAILED` used for a token mismatch. Other schema failures are `INVALID_REQUEST`.
4. Compare a schema-valid presented token with the discovery token using a constant-time comparison.
   Never include either value or validation details in logs or errors.
5. Verify that `protocol.minimum <= protocol.maximum`, select the highest daemon-supported version
   in the inclusive range, and reject the connection when no common version exists.
6. Validate and record the requested role and topology, then create the session bound to that role,
   protocol version, and connection.
7. Return the handshake response. Only after sending it may the daemon dispatch further messages.

For an invalid first message, the daemon returns JSON-RPC `-32600` / `INVALID_REQUEST` when it can
do so safely, then closes the connection. Invalid credentials return `-32001` /
`AUTHENTICATION_FAILED`; an incompatible version returns `-32002` /
`UNSUPPORTED_PROTOCOL_VERSION`. All handshake failures are non-retryable on the same connection,
return at most one error response, never echo the token, create no session, and close the socket.
A new connection has five seconds to complete its handshake; this timeout may only be configured
downward. A second `bridge/handshake` on an established session is an invalid request.

### Message handling

- All messages are JSON-RPC 2.0 objects (request, response, notification, or error).
- Message size limits are enforced at 10 MiB by default and may only be configured downward.
- Timeouts are enforced per request (proposed: 30s default, configurable).
- Cancellation is supported exclusively via the JSON-RPC notification `$/cancelRequest {id}`. The
  `id` identifies an in-flight request on the same session. No IDEBP-specific cancellation method
  is defined for the MVP.
- Heartbeat: the daemon sends periodic ping frames; sessions that miss the bounded number of
  complete pong windows are expired according to ADR-0010. `ide/ping` is an adapter diagnostic
  request, not the transport heartbeat.

### Transport abstraction

A `Transport` interface is defined to allow future implementations:

- `WebSocketTransport` (MVP)
- `UnixDomainSocketTransport` (future)
- `NamedPipeTransport` (future, Windows)
- `TunnelTransport` (future, remote development)

The abstraction covers: connect, disconnect, send, receive, close. Authentication and message framing are handled above the transport layer.

### Version negotiation

In the `bridge/handshake` request, the client announces:

```json
{
  "protocol": {
    "minimum": "0.1.0",
    "maximum": "0.1.0"
  }
}
```

The daemon selects a common version or refuses the session with `UNSUPPORTED_PROTOCOL_VERSION`.
The request and response also announce the respective endpoint topology. URI mappings, when
present, are explicit; neither side may infer a local path mapping.

## Consequences

- **Positive:** JSON-RPC 2.0 is well-understood, has good library support in both Node.js and Kotlin, and supports bidirectional notifications.
- **Positive:** WebSocket provides a persistent connection suitable for real-time notifications (document changes, capability changes, diagnostics).
- **Positive:** Loopback-only binding eliminates network attack surface.
- **Positive:** Transport abstraction allows adding UDS/named pipe without protocol changes.
- **Negative:** WebSocket adds a framing layer compared to raw TCP; this is acceptable given library maturity.
- **Negative:** Stateful sessions require the daemon to manage session lifecycle (heartbeat, expiration, cleanup).
- **Negative:** Token in discovery file requires file-system permission discipline.

## Alternatives Considered

### JSON-RPC over stdio

- Pros: No port management, no authentication needed (pipe inherits process trust).
- Cons: Requires the daemon and client to be parent/child processes; does not support multiple clients (multiple IDE windows, multiple adapters) naturally; no bidirectional notifications without extra plumbing.
- Rejected: The daemon must serve multiple adapters and clients independently.

### gRPC

- Pros: Strong typing, streaming support, efficient binary encoding.
- Cons: Requires protobuf schema (conflicts with JSON Schema 2020-12 as canonical); heavier dependency; less familiar for this domain; no advantage over JSON-RPC for loopback.
- Rejected: Adds complexity without proportional benefit for loopback.

### HTTP + Server-Sent Events

- Pros: Simpler, widely supported.
- Cons: Unidirectional server push (SSE) + separate request channel is more complex than a single WebSocket; no advantage for loopback.
- Rejected: WebSocket is simpler for bidirectional communication.

### Custom binary protocol

- Pros: Minimal overhead.
- Cons: No library support; high implementation cost; no debugging tools; poor developer experience.
- Rejected: JSON-RPC's self-describing messages are valuable for debugging and conformance testing.
