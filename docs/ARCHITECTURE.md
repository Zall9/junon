# IDE Bridge — Architecture

> This document reflects the full scope of `TASK.md`. It does not silently reduce scope. Deferred features are explicitly marked.

---

## 1. System Overview

```text
Agent IA / MCP client
        │
        ▼
Serena or other integration
        │
        │ IDE Bridge Protocol (IDEBP)
        ▼
IDE Bridge Daemon
        │
        ├── Adapter VS Code
        │       └── VS Code native APIs + installed providers
        │
        └── Adapter JetBrains
                └── PSI, indexes, native refactoring APIs
```

The daemon is the central router. Adapters connect to it over loopback WebSocket. Agents (or MCP clients like Serena) connect to the daemon via the same protocol.

---

## 2. Core Principles

IDEBP must be:

- **IDE-independent:** No VS Code or JetBrains types in the protocol.
- **Language-independent:** No language-specific logic in protocol definitions.
- **Versioned:** Protocol version negotiated at handshake.
- **Capability-oriented:** Every operation declares its support level and the dimensions applicable
  to that operation.
- **Multi-workspace:** Supports multiple windows and multiple workspaces simultaneously.
- **Revision-aware:** Every document carries a revision; stale revisions are rejected.
- **Undoable:** Operations are designed for undo via undo tokens.
- **Explicit guarantee level:** Capabilities that claim a semantic, syntactic, or textual quality
  declare `semantic`, `syntactic`, `anchored-text`, or `raw-text`.

IDEBP is not a replacement for LSP. It reuses LSP concepts (URI, position, range, diagnostic, text edit, workspace edit) but adds adapter, workspace, session, capability, guarantee, document revision, symbol handle, symbol locator, edit plan, precondition, atomicity, readiness, and undo token.

---

## 3. Protocol (IDEBP)

### 3.1 Transport

JSON-RPC 2.0 over WebSocket. See ADR-0001 for the full decision.

- Daemon listens on `127.0.0.1` and/or `::1` only.
- Dynamic port by default.
- Token: >= 256 bits, cryptographically secure random.
- Private discovery file with restrictive permissions.
- Unauthenticated connections refused.
- Message size limits, timeouts, cancellation support.
- Heartbeat and session expiration.
- Transport abstraction for future UDS, named pipe, tunnel.

### 3.2 Version Negotiation

The first application message on every connection is the authenticated `bridge/handshake` request.
It declares session role (`adapter` or `consumer`), minimum and maximum protocol versions, client
identity, and topology. The daemon validates and authenticates this request before dispatching any
other message, selects the highest common version, binds the role/topology to a new session, and
returns its own topology. `ide/register` is adapter-only and occurs after this handshake; consumers
do not register as IDEs. See `docs/PROTOCOL.md` and ADR-0001.

### 3.3 Position Encoding

- MVP: `utf-16` (matching VS Code and LSP convention).
- Protocol prepared for `utf-8` and `utf-32`.
- Each adapter announces supported encodings.
- All ranges must indicate or inherit the encoding used.

### 3.4 Discovery File

```json
{
  "protocolVersion": "0.1.0",
  "endpoint": "ws://127.0.0.1:41731/rpc",
  "token": "<unpadded-base64url-token-of-at-least-32-random-bytes>",
  "pid": 12345,
  "startedAt": "2026-08-01T12:00:00Z"
}
```

Created with the most restrictive permissions possible. Token is never logged.

---

## 4. Capability Model

Each capability declares `support`. Other dimensions are operation-dependent: `guarantee` describes
semantic/syntactic quality, `atomicity` describes edit application, and `preview` describes whether
an operation can be prepared. Absence means “not applicable”, never an implicit guarantee. See
ADR-0005.

```json
{
  "document.symbols": {
    "support": "native",
    "guarantee": "semantic"
  },
  "refactor.rename": {
    "support": "provider",
    "guarantee": "semantic",
    "preview": true
  },
  "symbol.editRegion": {
    "support": "unavailable"
  },
  "workspace.applyEdit": {
    "support": "native",
    "atomicity": "text-only"
  }
}
```

### Support values

| Value | Meaning |
|-------|---------|
| `native` | Built into the IDE |
| `provider` | Available via installed language provider |
| `adapter` | Synthesized by the adapter (not native/provider) |
| `unavailable` | Not supported |

### Guarantee values

| Value | Meaning |
|-------|---------|
| `semantic` | Resolution/refactoring by IDE or semantic provider |
| `syntactic` | Guaranteed by parser or syntax tree |
| `anchored-text` | Textual operation protected by hash and context |
| `raw-text` | Raw range operation, no structural guarantee |

A `raw-text` capability must never be presented as semantic.

---

## 5. Documents and Revisions

See ADR-0002 for the full decision.

```json
{
  "workspaceId": "ws_42",
  "rootId": "root_api",
  "uri": "file:///home/user/project/src/service.ts",
  "logicalPath": "src/service.ts",
  "revision": {
    "editorVersion": 27,
    "contentHash": "sha256:...",
    "workspaceEpoch": 148
  }
}
```

- `uri` is the primary identity.
- `logicalPath` is informational.
- Never assume two processes see the same OS path.
- Distinguish in-memory content from saved content.
- Stable hash computed from buffer content.
- Epoch increments when semantic caches may be invalidated.
- Operations prepared on a stale revision return `STALE_DOCUMENT`.

---

## 6. Symbols

See ADR-0003 for the full decision.

Each symbol has:

1. **Handle** — opaque, fast, temporary. Bound to adapter, session, and epoch.
2. **Locator** — persistent. Allows finding the symbol again.

```json
{
  "handle": {
    "adapterId": "adapter_1",
    "sessionId": "session_1",
    "id": "sym_123",
    "validUntilEpoch": 151
  },
  "locator": {
    "documentUri": "file:///project/src/service.ts",
    "name": "update",
    "qualifiedName": "StreamService.update",
    "kind": "method",
    "containerName": "StreamService",
    "selectionRange": { "start": { "line": 10, "character": 2 }, "end": { "line": 10, "character": 8 } },
    "fingerprint": "sha256:..."
  }
}
```

- A name is not a sufficient identity.
- Support overloads, nested symbols, same-name symbols in one file.
- Handles invalidated on relevant changes.
- Controlled relocation attempted before returning `STALE_SYMBOL`.
- `AMBIGUOUS_SYMBOL` with candidates instead of arbitrary selection.

---

## 7. Two-Phase Edits (Prepare / Apply)

See ADR-0004 for the full decision.

### Prepare

`refactor/prepareRename` → returns a plan with preconditions, changes preview, guarantee, atomicity, expiration.

`refactor/prepare` does the same for the rest of the vocabulary. Four operations have behaviour
behind them — `rename`, `reformat`, `optimizeImports`, `quickFix` — and the structural refactorings
(`extractMethod`, `inline`, `move`, `changeSignature`) are **refused by name**: the platform exposes
them only through dialog-driven handlers, which cannot run behind a socket. See ADR-0028.

### Apply

`workspace/applyPlan` → validates all preconditions, applies changes, returns modified documents, before/after hashes, invalidates handles, returns undo token.

### Plan lifecycle

- Bound to adapter, session, workspace.
- Non-reusable after application.
- Automatically expired.
- Explicitly discardable (`workspace/discardPlan`).
- Invalidated on relevant document changes.

---

## 8. Readiness and Indexing

States: `initializing`, `indexing`, `ready`, `degraded`, `disconnected`.

```json
{
  "workspaceId": "ws_42",
  "state": "indexing",
  "capabilitiesUnavailable": ["workspace.searchSymbols", "symbol.getReferences", "refactor.rename"],
  "progress": { "known": false }
}
```

Index-dependent operations return `INDEX_NOT_READY` (retryable).

---

## 9. Error Model

All errors from TASK.md §14:

```
INVALID_REQUEST, UNSUPPORTED_PROTOCOL_VERSION, AUTHENTICATION_FAILED,
WORKSPACE_NOT_FOUND, DOCUMENT_NOT_FOUND, ADAPTER_NOT_FOUND,
ADAPTER_DISCONNECTED, CAPABILITY_UNAVAILABLE, INDEX_NOT_READY,
STALE_DOCUMENT, STALE_SYMBOL, AMBIGUOUS_SYMBOL, INVALID_IDENTIFIER,
PRECONDITION_FAILED, PLAN_NOT_FOUND, PLAN_EXPIRED, PROVIDER_FAILED,
TIMEOUT, CANCELLED, PERMISSION_DENIED, PARTIAL_APPLY, INTERNAL_ERROR
```

Each error contains: stable code, human message, retryable flag, structured data, no sensitive stack trace by default.

---

## 10. Daemon

### Session registry

Maintains: adapters, sessions, workspaces, capabilities, readiness, heartbeats, last-activity timestamps.

The daemon sends WebSocket ping control frames from one transport-wide, unref'ed interval. Pong or
authenticated application traffic resets the bounded missed-heartbeat count and touches
`lastActivityAt`. Expiration uses the same authoritative session-close path as transport failure, so
routes, plans, adapters, and workspaces cannot outlive their session (ADR-0010).

### Routing

Routes requests by `adapterId`, `workspaceId`, `sessionId`. Never cross-routes a workspace operation to another adapter without explicit decision.

### Plan store

In-memory for MVP. Interface for future storage. Handles: expiration, invalidation, atomic consumption, workspace search, periodic cleanup.

### CLI

```bash
ide-bridge daemon      # Start daemon
ide-bridge status      # Daemon status
ide-bridge adapters    # List adapters
ide-bridge workspaces  # List workspaces
ide-bridge doctor      # Health checks
```

`@ide-bridge/cli` composes the daemon and shared client without duplicating JSON-RPC. `daemon` runs
in the foreground, acquires a private sibling ownership record, publishes discovery only after the
loopback server is listening, and converges `SIGINT`/`SIGTERM` on one cleanup path. Query commands
are short-lived authenticated consumers with five-second request bounds. Success and doctor reports
are JSON on stdout; structured daemon logs and canonical payload-free errors use stderr. See
ADR-0012.

`doctor` checks discovery parsing, Unix permissions/ownership, daemon PID, authenticated port
reachability, protocol compatibility, registered adapters/workspace readiness, and session activity
against the maximum permitted heartbeat window. It never repairs or deletes state.

### Observability

The daemon exposes the closed structured event catalogue defined by ADR-0011. Records carry level,
component, canonical event/result, a process-local HMAC correlation for peer-controlled request IDs,
generated session ID when relevant, method and monotonic dispatch duration. Explicit allowlisting
prevents payloads, raw errors, URIs, source/replacement text, and diagnostic contents from reaching
the JSON-lines sink. Emission is rate bounded and sink failure cannot affect protocol work. The
library defaults to silent; CLI/doctor will own sink and level selection. No telemetry.

---

## 11. Shared TypeScript Client

`packages/bridge-client` provides:

- Daemon discovery
- Authentication through a private discovery file and a schema-validated `bridge/handshake`
- Reconnection
- Typed JSON-RPC calls
- Notifications
- Timeouts, cancellation via `$/cancelRequest {id}`
- Version verification
- Runtime validation
- Typed errors

Current Phase 2 status: discovery, authenticated adapter/consumer sessions, typed outbound RPC,
notifications, per-request timeout, and cancellation are implemented. The composed daemon registry
and router answer local methods, reject unadvertised capabilities, route read-only workspace
operations with role/ownership checks and per-hop request IDs, and own the prepare/apply/discard/undo
state machine through session-bound public/private plan identities. The shared client also exposes a
typed, bounded inbound dispatcher for all thirteen routed methods on adapter sessions, including
method-correlated result validation, cooperative cancellation, and exact-once settlement.
An opt-in lifetime facade reconnects after daemon restart by rereading the private discovery file on
every bounded-backoff attempt. Every physical connection has a new session; pending work fails and
is never replayed. Logical handlers persist, while adapters rebuild current registration state in a
bounded restoration callback before the facade becomes connected again (ADR-0009).

The VS Code extension must use this client. No JSON-RPC code duplication in the extension.

---

## 12. VS Code Adapter

- Official VS Code API only.
- Extension host (workspace type).
- One VS Code window maps to one IDEBP workspace; workspace folders map to roots.
- Empty windows advertise no workspace. Root topology changes advance the workspace epoch.
- Preserve `Uri.toString()` values across the wire; never use `fsPath` as protocol identity.
- Revisions hash `TextDocument.getText()` as UTF-8 and therefore include unsaved buffers.
- No direct writes bypassing `WorkspaceEdit`.
- Dynamic capability detection (provider presence).
- Unsaved buffer revision hashing (in-memory content, not just disk).
- Workspace trust: safe reads allowed, writes blocked, `PERMISSION_DENIED` on write attempt.
- Event connections: open, change, save, close, rename, delete, folder change, trust change.
- No public network listen configuration in MVP.

The desktop entry point is CommonJS and activates on `onStartupFinished`; see ADR-0013. A build
bundles all ESM IDE Bridge dependencies into autonomous CommonJS extension and daemon-child entries;
only `vscode` remains external. The lifecycle reuses the shared reconnecting client, rebuilds current
registration before a recovered session becomes visible, and uses the CLI's foreground ownership
for local Unix auto-start (ADR-0014). Native document reads resolve exact VS Code workspace roots,
hash captured in-memory buffers asynchronously, and publish coalesced document plus truthful root
events only after registration (ADR-0015). Dynamic trust, rename, and delete events remain explicit
gaps. Document symbols use only VS Code's fixed document-symbol provider command, compare the
in-memory revision before and after provider execution, map provider DTOs into bounded IDEBP trees,
and mint handles from the physical authenticated session. Document changes invalidate handles
before notification debounce; reconnect/root epoch changes invalidate all handles (ADR-0016). VSIX
packaging and a real extension-host launch are Phase 3 acceptance checks and must not be inferred
from bundle compilation alone.

---

## 13. JetBrains Adapter

- Kotlin, IntelliJ Platform SDK.
- Application service (daemon connection) + project service (workspace registration).
- Symbol handle registry (smart PSI pointers).
- PSI-to-IDEBP DTO mapping.
- Threading: no heavy PSI on EDT, read actions, write commands, smart mode waits.
- PSI validity checks.
- Rename via JetBrains refactoring API.
- Dumb mode disables index-dependent capabilities.
- Diagnostics: minimal but real for MVP.

---

## 14. Serena Integration

- Python `ide_bridge` backend in `integrations/serena/`.
- No Serena coupling in protocol or IDE plugins.
- Capability-aware tool exposure (enable/disable tools based on IDEBP capabilities).
- No automatic text fallback when semantic operation refused.
- Config: `discovery_file`, `workspace`, `request_timeout_seconds`, `prefer_adapter`.

---

## 15. Conformance Suite

Independent of IDEs. Tests any IDEBP adapter. All scenarios from TASK.md §22:

- Registration, workspaces, documents, symbols, references, rename, security.
- Unicode (non-BMP), CRLF, multi-root, stale plan, replay, ambiguity.

---

## 16. Remote Development

Full design in `docs/REMOTE_DEVELOPMENT.md`. Key principle: adapter, daemon, and agent should run in the same environment as the workspace when possible. When not possible: preserve source URIs, use explicit mapping, never guess, announce topology in handshake.

Types defined: `hostKind` (local, remote-workspace, web, gateway) and `environmentKind` (local, ssh, wsl, dev-container, codespace, jetbrains-remote, unknown).

---

## 17. Roadmap (Post-MVP)

Per TASK.md §29 and §20:

- Symbolic editing: `symbol/getEditableRegions`, `symbol/prepareRegionEdit` with region types (wholeDeclaration, body, expression, statementList, initializer, signature) and replacement formats (regionContent, wholeDeclaration, expression, statementList).
- Debugger, breakpoints, runtime evaluation.
- Inline method, move class, safe delete, change signature, extract method.
- Multi-user collaboration.
- Durable plan persistence.
- Public network transport.
- Application-level encryption.
- Full browser support.
- Full language support.
- Marketplace publication, auto-update, telemetry.
- Windows, WSL, Dev Containers, SSH, Codespaces, JetBrains Remote full support.
