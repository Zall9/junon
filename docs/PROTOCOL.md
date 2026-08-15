# IDE Bridge Protocol — Wire Contract

> JSON Schema 2020-12 files in `packages/protocol/schemas/` are the canonical wire definitions.
> Examples in this document are explanatory and must remain consistent with those schemas.

---

## 1. Connection state

Every WebSocket connection starts in `awaiting-handshake`. The first application message must be a
JSON-RPC 2.0 `bridge/handshake` request. No notification or other method, including `ide/register`,
is routed before the handshake succeeds.

```text
WebSocket open
  → bridge/handshake request
  → schema validation
  → constant-time token verification
  → version negotiation
  → role/topology binding
  → bridge/handshake response
  → authenticated session
```

`ide/register` is only used by a session whose handshake role is `adapter`. A consuming client such
as Serena, a CLI, or another MCP integration uses role `consumer` and does not call `ide/register`.

## 2. Handshake request

Method: `bridge/handshake`

Schema: `packages/protocol/schemas/bridge/handshake-request.schema.json`

```json
{
  "jsonrpc": "2.0",
  "id": "handshake-1",
  "method": "bridge/handshake",
  "params": {
    "authentication": {
      "method": "token",
      "token": "<unpadded-base64url-token-of-at-least-32-random-bytes>"
    },
    "role": "consumer",
    "protocol": {
      "minimum": "0.1.0",
      "maximum": "0.1.0"
    },
    "topology": {
      "hostKind": "local",
      "environmentKind": "local",
      "uriSchemes": ["file"]
    },
    "clientInfo": {
      "name": "serena-ide-bridge",
      "version": "0.1.0"
    }
  }
}
```

The range is inclusive. Schema validation checks the version syntax; daemon processing must also
verify that `minimum` is not greater than `maximum`. The daemon selects the highest supported
version in the intersection.

Roles:

| Role | Purpose | Post-handshake lifecycle |
|------|---------|--------------------------|
| `adapter` | Exposes IDE-backed operations | Calls `ide/register`, then registers workspaces and capabilities |
| `consumer` | Invokes daemon or adapter operations | Selects from registered adapters/workspaces; never calls `ide/register` |

Topology uses `hostKind` and `environmentKind` values defined in `docs/REMOTE_DEVELOPMENT.md`.
`uriSchemes` contains URI schemes without `://`. Optional `uriMappings` entries explicitly map URI
prefixes and direction; absence of a mapping never permits path guessing.

## 3. Successful response

Schema: `packages/protocol/schemas/bridge/handshake-response.schema.json`

```json
{
  "jsonrpc": "2.0",
  "id": "handshake-1",
  "result": {
    "sessionId": "session_7M4y",
    "role": "consumer",
    "protocolVersion": "0.1.0",
    "daemonInfo": {
      "name": "ide-bridge-daemon",
      "version": "0.1.0"
    },
    "topology": {
      "hostKind": "local",
      "environmentKind": "local",
      "uriSchemes": ["file"]
    }
  }
}
```

The returned role must equal the requested role. The session is bound to the connection, selected
protocol version, role, and declared topology. The client may send further messages only after it
receives this response.

The shared TypeScript client validates the complete response schema, requires the response ID to
equal its handshake request ID, and verifies both the requested role and its supported protocol
version before exposing the authenticated connection.

## 4. Handshake failures

Schema: `packages/protocol/schemas/bridge/handshake-error-response.schema.json`

| JSON-RPC code | IDEBP code | Condition |
|---------------|------------|-----------|
| `-32600` | `INVALID_REQUEST` | The first message is malformed, is a notification, or is not `bridge/handshake` |
| `-32001` | `AUTHENTICATION_FAILED` | Token is absent, malformed, or does not match |
| `-32002` | `UNSUPPORTED_PROTOCOL_VERSION` | No daemon-supported version is in the requested range |

Error classification has a deliberate precedence. A malformed JSON-RPC envelope, notification, or
wrong first method is `INVALID_REQUEST`. Once a request is recognizable as `bridge/handshake`, an
absent, malformed, or non-matching authentication value produces the same generic
`AUTHENTICATION_FAILED`; malformed non-authentication parameters remain `INVALID_REQUEST`.

Every failure is non-retryable on the same connection. The daemon returns at most one safe error
response, creates no session, and closes the WebSocket. Authentication errors are deliberately
generic and never contain the presented or expected token. An idle unauthenticated connection is
closed after at most five seconds.

Authenticated liveness uses daemon-originated WebSocket ping control frames, not JSON-RPC messages.
A pong or any authenticated application message refreshes session activity. Missing the configured
number of complete response windows expires the session and applies the normal ownership cleanup.
`ide/ping` remains an adapter-originated diagnostic echo with `sentAt`/`receivedAt`; it is not the
transport heartbeat. See ADR-0010.

## 5. Cancellation

IDEBP uses the JSON-RPC notification `$/cancelRequest` exclusively for MVP cancellation:

```json
{
  "jsonrpc": "2.0",
  "method": "$/cancelRequest",
  "params": {
    "id": "request-42"
  }
}
```

The identifier refers to an in-flight request in the same authenticated session. The shared
TypeScript client emits this notification on per-request timeout and `AbortSignal` cancellation and
keeps settlement atomic across response/cancellation races. The daemon rewrites the consumer ID to
its per-hop route ID before forwarding cancellation to the adapter. Adapter handlers receive a
per-request `AbortSignal`; a bounded completion grace absorbs one valid cancellation that crosses an
already-sent response on the two sockets.

The client validates every outgoing request and notification against the canonical schema. A
success response is validated against the method retained with its pending request ID; a generic
success envelope is insufficient because JSON-RPC responses do not carry a method. Unknown IDs,
wrong method result shapes, malformed messages, and unknown notifications fail closed. One canonical
late response after local timeout or cancellation is tolerated through a bounded grace set.

The daemon applies the role and ownership matrix from ADR-0006 after authentication. Adapter
registration binds one live session to its adapter and workspaces. Routed requests are resolved by
exact `workspaceId` and an advertised, available capability; their consumer-scoped IDs are replaced
with daemon route IDs before forwarding and restored only after a method-correlated adapter
response. Cancellation uses the originating session plus original ID and is forwarded with the
route ID. Prepare/apply/discard/undo are intercepted by the ADR-0007 plan store: consumers receive
daemon-owned plan and undo IDs, while adapters see only their session-scoped internal IDs.

The protocol package exports frozen, exhaustively tested method and notification partitions for
adapter- and consumer-originated traffic. The shared client and daemon derive their role checks from
those partitions. Inbound adapter results and declared normalized errors are validated against the
original routed method before they cross the connection boundary.

## 6. Schema catalogue

The Phase 1 schema set is organised by responsibility:

| Path | Contracts |
|------|-----------|
| `schemas/common/` | IDs, positions, topology, capabilities, workspaces, revisions, documents, symbols, diagnostics, adapters/sessions, edit plans |
| `schemas/bridge/` | Authenticated handshake request, response, and failures |
| `schemas/discovery/` | Private daemon discovery-file contract |
| `schemas/method/` | Request and response fragments for all 27 application methods, 16 of them routed to adapters |
| `schemas/notification/` | All 13 MVP events plus `$/cancelRequest` |
| `schemas/error/` | All 22 normalized IDEBP error codes and structured error data |

Every method request/response and event has a named schema entry. The fixture validator compiles
all top-level schemas and `$defs` fragments with Ajv 2020-12 in strict mode before validating the
wire fixtures. This prevents an unexercised public fragment from retaining a broken reference.

TypeScript types in `packages/protocol/src/generated.ts` are generated from this catalogue by
`scripts/generate-types.ts`. The generated file is never the source of a wire-contract change.
The package exports canonical runtime artifacts through `@ide-bridge/protocol/schemas/*`; fixture
support schemas live separately under `packages/protocol/fixtures/schemas/` and are not wire
contracts.

```bash
pnpm protocol:fixtures
pnpm protocol:generate
pnpm protocol:generate:check
```

`protocol:generate:check` fails when a schema change has not been reflected in the checked-in types.

## 7. Contract invariants

- URI strings remain URIs across the wire. Non-local schemes such as `vscode-remote` are preserved.
- Wire positions explicitly carry or inherit a declared encoding; MVP adapters must support
  `utf-16`.
- Every capability declares `support`; `guarantee`, `atomicity`, and `preview` are present only when
  applicable to that operation, as defined by ADR-0005.
- A document revision contains `editorVersion`, SHA-256 `contentHash`, and `workspaceEpoch`.
- Returned symbols contain both an adapter/session-bound handle and a persistent locator.
- Every edit plan is bound to an adapter, session, and workspace and contains at least one complete
  document-revision precondition.
- Modification results carry before/after hashes and may carry a bound undo token.
- Event notifications never contain full document content or replacement text.
- Error data contains a stable code and `retryable`; `INDEX_NOT_READY` is always retryable, stale
  documents include the current revision, ambiguous symbols include candidates, and partial apply
  includes modified documents. Stack traces and arbitrary properties are rejected.
