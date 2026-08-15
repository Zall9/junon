# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/workspace/

## Responsibility

Maps an open IntelliJ project, its lifecycle, and its readiness onto the IDE Bridge Protocol (IDEBP) wire types, and registers the adapter with the daemon. This is the adaptation boundary where the IDE's notions of "project", "content roots", "trust", and "index readiness" become protocol `Workspace`, `WorkspaceStatus`, and capability announcements — without a single IntelliJ platform object crossing the wire. Four pure-Kotlin files: `WorkspaceModel` (project→workspace mapping + stable root IDs + epoch), `ReadinessModel` (dumb/smart→IDEBP readiness), `AdapterRegistration` (ide/register + capability truth), and `WorkspaceUri` (URI containment, shared with the daemon).

## Design Patterns

- **Snapshot / Anti-corruption layer** — `WorkspaceModel.ProjectSnapshot` interface (`WorkspaceModel.kt:29-36`) lets mapping rules be tested without the platform; `IntelliJProjectSnapshot` (in `platform/`) is the only thing that reads live IntelliJ state and feeds it in. No IntelliJ type leaks past this boundary (AGENTS.md §3).
- **Truthful refusal** — `AdapterRegistration.capabilities()` (`AdapterRegistration.kt:43-51`) declares every unimplemented method `Support.UNAVAILABLE` with a reason rather than omitting it. Consumers see a refusal, not an absence.
- **Stable identity with epoch invalidation** — `WorkspaceModel` keeps root IDs in a `linkedMapOf` (`WorkspaceModel.kt:49`) so a root keeps its ID while its URI is unchanged; `epoch` advances only on real root-set changes (`WorkspaceModel.kt:103`) or explicit `invalidateSemanticState()` on reconnect (`WorkspaceModel.kt:93-96`).
- **Fails-closed validation** — `WorkspaceUri` rejects NUL, backslash, query, fragment, and dot-segments escaping above root (`WorkspaceUri.kt:59-77`); `WorkspaceModel.snapshot()` rejects duplicate and non-URI roots (`WorkspaceModel.kt:59-65`).
- **Shared test vectors (ADR-0025)** — `WorkspaceUri` is a second implementation of a rule the daemon also enforces; both are checked against one shared vector file, not cases written twice.

## Key Types

### `WorkspaceModel` (`WorkspaceModel.kt:23-121`)
The project→workspace mapper. Holds `adapterId`, a generated `workspaceId`, and a root-ID factory.
- `ProjectSnapshot` (interface, `:29-36`) — what the model needs from a project: `name`, `rootUris: List<String>`, `trust: TrustState`. Deliberately no platform types.
- `TrustState` (enum, `:43-47`) — `GRANTED` / `DENIED` / `UNDECIDED`. Maps to `WorkspaceTrust.TRUSTED` / `UNTRUSTED` / `UNKNOWN` (`:81-85`). Only `GRANTED` permits writes; `UNDECIDED` fails closed while staying truthful.
- `rootIds: linkedMapOf<String, RootId>` (`:49`) — stable per-URI root IDs; insertion order preserved.
- `epoch: Int` (`:50`) — advances on root-set change or `invalidateSemanticState()`; never needlessly bumped.
- Companion `createIdentifier(prefix)` (`:115-119`) — 18 random bytes via `SecureRandom`, URL-safe Base64, no padding. Opaque and unguessable.

### `ReadinessModel` (object, `ReadinessModel.kt:19-76`)
Maps IntelliJ index state to IDEBP readiness. The first adapter where readiness is observable (VS Code exposes no index signal; ADR-0019).
- `INDEX_DEPENDENT_METHODS: List<String>` (`:26-38`) — 11 methods that cannot answer without indexes (workspace/searchSymbols, symbol/resolveAt, getDefinition, getReferences, getImplementations, document/getSymbols, diagnostics/getSnapshot, refactor/prepareRename, workspace/applyPlan, discardPlan, undo). Document reads/revisions are deliberately excluded — they only need the document.
- `IndexState` (enum, `:40-52`) — `INITIALIZING` / `DUMB` / `SMART` / `DISCONNECTED`.
- `status(workspaceId, state): WorkspaceStatus` (`:54-71`) — `DUMB`→`INDEXING`, `SMART`→`READY`. `capabilitiesUnavailable` is `INDEX_DEPENDENT_METHODS` when not SMART, else empty. Progress is always indeterminate (`known = false`) — the platform reports a percentage too rarely to claim one.
- `isBlocked(method, state)` (`:74-75`) — true when method is index-dependent and state ≠ SMART.

### `AdapterRegistration` (`AdapterRegistration.kt:24-103`)
Registers the adapter via `ide/register` and verifies the daemon's response.
- `Outcome` (sealed, `:30-34`) — `Registered(workspaces)` / `Rejected(detail)`.
- `capabilities(): Map<String, Capability>` (`:43-51`) — all `INDEX_DEPENDENT_METHODS` plus `document/read` and `document/getRevision` declared `UNAVAILABLE` with reason.
- `register(client, workspaces): Outcome` (`:53-75`) — builds `IdeRegisterParams` (UTF16 only) fresh each call, calls `ide/register`, then `verify()`.
- `unregister(client): Boolean` (`:77-87`) — calls `ide/unregister`; true only if daemon confirms unregistered + matching adapterId.
- `verify(result, sent): Outcome` (`:89-102`) — rejects if daemon echoes a different adapterId, a different workspace set, or assigns a workspace to another adapter.

### `WorkspaceUri` (object, `WorkspaceUri.kt:19-78`)
URI containment check (second implementation, shared vectors per ADR-0025).
- `isWithinRoot(documentUri, rootUri): Boolean` (`:20-35`) — scheme + authority must match; query/fragment rejected; path segments normalized and prefix-compared.
- `hasScheme(value): Boolean` (`:38`) — true when the value parses as a URI with a scheme.
- `normalizedSegments(rawPath): List<String>?` (`:59-77`) — percent-decodes, rejects NUL/backslash, resolves dot segments; returns null (fails closed) on decode failure or `..` escaping above root.

## Key Functions

- `WorkspaceModel.snapshot(project: ProjectSnapshot): Workspace?` (`WorkspaceModel.kt:57-87`) — Returns null for no content roots; otherwise builds `Workspace` with stable root IDs and current epoch. Rejects duplicate and non-URI roots.
- `WorkspaceModel.invalidateSemanticState(): Int` (`:93-96`) — Bumps epoch for reconnect; revokes handles/plans from a prior session.
- `ReadinessModel.status(workspaceId, state): WorkspaceStatus` (`ReadinessModel.kt:54-71`) — The single source of readiness mapping; indeterminate progress.
- `AdapterRegistration.register(client, workspaces): Outcome` (`AdapterRegistration.kt:53-75`) — The wire registration; UTF16-only position encoding.
- `WorkspaceUri.isWithinRoot(documentUri, rootUri): Boolean` (`WorkspaceUri.kt:20-35`) — Containment; never converts to a local path.

## Data & Control Flow

```
IntelliJ project (live)
   │  IntelliJProjectSnapshot.capture() [platform/]
   ▼
WorkspaceModel.ProjectSnapshot (name, rootUris, trust)
   │  WorkspaceModel.snapshot()   ──►  Workspace (protocol DTO, stable root IDs, epoch)
   │                                    │
   │  ReadinessModel.status()     ──►  WorkspaceStatus (state, capabilitiesUnavailable, progress)
   │                                    │
   └──────────────────────────────────►│  AdapterRegistration.register(RpcClient, workspaces)
                                        │   ide/register (UTF16, truthful capabilities)
                                        ▼
                                   daemon (bridge-daemon)
```

Registration parameters are rebuilt from current project state on every call — never cached — so a reconnect tells the daemon what is true now (`AdapterRegistration.kt:18-20`). The daemon response is verified, not assumed (`:89-102`).

## Integration Points

- **Consumed by:**
  - `platform/IntelliJProjectSnapshot` — the sole live-IntelliJ reader; feeds `WorkspaceModel.ProjectSnapshot` and `ReadinessModel.IndexState`.
  - `document/DocumentModel` — imports `WorkspaceUri` for containment checks (`DocumentModel.kt:9`).
  - `symbol/SymbolHandleRegistry` — imports `WorkspaceModel` for `createIdentifier` (handle ID minting) (`SymbolHandleRegistry.kt:10`).
  - Tests in `src/test/kotlin/.../platform/` exercise the workspace + readiness + URI modules.
- **Depends on:**
  - `com.idebridge.jetbrains.protocol.*` — all wire DTOs (`Workspace`, `WorkspaceRoot`, `WorkspaceStatus`, `Capability`, `PositionEncoding`, `ReadinessState`, etc.).
  - `com.idebridge.jetbrains.connection.RpcClient` — the JSON-RPC client used by `AdapterRegistration`.
  - JDK only (`java.security.SecureRandom`, `java.net.URI`, `java.net.URLDecoder`).
- **External boundaries:**
  - RPC methods `ide/register` and `ide/unregister` (`AdapterRegistration.kt:65,79`).
  - Position encoding fixed to UTF16 (`AdapterRegistration.kt:60`).
  - Discovery/auth handled elsewhere (in `connection/`); this package trusts the `RpcClient` it is handed.

## Common Gotchas

- **Epoch advances only on real change.** The first snapshot establishes the baseline and does NOT bump the epoch (`WorkspaceModel.kt:103`, `initialized` guard). `invalidateSemanticState()` is the only way to force an epoch bump (for reconnect). Bumping needlessly would revoke every live handle.
- **`UNDECIDED` is not `DENIED`.** The protocol has a three-state trust; `UNDECIDED` maps to `WorkspaceTrust.UNKNOWN` (`WorkspaceModel.kt:84`). Only `TRUSTED` permits writes; `UNKNOWN` fails closed but stays truthful. The `platform/` layer currently cannot observe `UNDECIDED` from IntelliJ's public API and collapses it to `DENIED` — a loss of fidelity, not safety (`IntelliJProjectSnapshot.kt:46-60`).
- **Capabilities must be truthful.** Unimplemented methods are declared `UNAVAILABLE` with a reason, never omitted (`AdapterRegistration.kt:43-51`, AGENTS.md §1 "Do not hide unsupported capabilities"). Adding a method to `INDEX_DEPENDENT_METHODS` without implementing it keeps the refusal truthful only if it stays in that list.
- **`WorkspaceUri` must agree with the daemon exactly.** It is a second implementation of the daemon's containment rule; a looser adapter rule returns URIs the daemon rejects as a policy violation and loses its session. Both are checked against `packages/protocol/fixtures/vectors/uri-containment-vectors.json` (ADR-0025).
- **Registration params are never cached.** After a reconnect the daemon must be told what is true now, not what was true at startup (`AdapterRegistration.kt:18-20`).
- **UTF16 only.** JetBrains position encoding is announced as UTF16 alone (`AdapterRegistration.kt:60`). The offset-to-codepoint story is owned by the daemon/client.
- **Document reads/revisions are NOT index-dependent.** They remain available in dumb mode and must not appear in `INDEX_DEPENDENT_METHODS` (`ReadinessModel.kt:23-25`).
- **Progress is always indeterminate.** `ReadinessProgress(known = false)` — never invent a percentage (`ReadinessModel.kt:68-70`).
