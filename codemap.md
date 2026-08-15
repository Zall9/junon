# IDE Bridge — Root Codemap Atlas

> **Canonical structural map of the IDE Bridge monorepo.**
> Each entry links to the directory's `codemap.md` with a one-line responsibility summary.

## What This Project Is

IDE Bridge (IDEBP) is a protocol and daemon that lets AI agents (like Serena) communicate with VS Code and JetBrains IDEs through a unified, IDE-independent, language-independent, versioned, capability-oriented, revision-aware protocol over loopback WebSocket.

## Architecture

```
Consumer (AI agent / MCP client)
    │
    ▼
Serena or other integration
    │
    │ IDE Bridge Protocol (IDEBP) — JSON-RPC 2.0 over WebSocket
    ▼
IDE Bridge Daemon (loopback only, authenticated)
    │
    ├── CLI tool (status, adapters, workspaces, doctor, daemon)
    │
    ├── VS Code Adapter (TypeScript extension — serves 13 of 16 routed methods)
    │       └── VS Code native APIs + installed providers
    │
    └── JetBrains Adapter (Kotlin IntelliJ plugin — serves all 16 routed methods; run in IntelliJ, PhpStorm, GoLand, PyCharm)
            └── PSI, indexes, refactoring APIs
```

## Directory Map

| Directory                                                              | Responsibility                                                                                                                                                                                                  | Codemap                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/protocol/src/`                                               | JSON Schema 2020-12 wire contracts, generated TypeScript types, runtime Ajv validation, method classification, canonical URI containment (`isUriWithinWorkspaceRoot`), protocol constants                       | [codemap.md](packages/protocol/src/codemap.md)                                               |
| `packages/bridge-daemon/src/`                                          | WebSocket JSON-RPC 2.0 server orchestrator (composes transport, session registry, application router, plan store, structured logger)                                                                            | [codemap.md](packages/bridge-daemon/src/codemap.md)                                          |
| `packages/bridge-daemon/src/transport/`                                | Loopback-only WebSocket server with connection state machine, handshake enforcement, typed rejection reasons, message size/time bounds                                                                          | [codemap.md](packages/bridge-daemon/src/transport/codemap.md)                                |
| `packages/bridge-daemon/src/session/`                                  | Handshake processor (token auth, version negotiation) and in-memory session/adapter/workspace registry with defensive cloning, trust-only updates, monotonic epoch                                              | [codemap.md](packages/bridge-daemon/src/session/codemap.md)                                  |
| `packages/bridge-daemon/src/routing/`                                  | Application router (1619 lines): routed ID remapping, plan-store integration, symbol/diagnostic/URI authority validation, notification broadcast, symbol bounds check, metrics instrumentation (ADR-0035)       | [codemap.md](packages/bridge-daemon/src/routing/codemap.md)                                  |
| `packages/bridge-daemon/src/security/`                                 | 256-bit authentication token (SHA-256+timingSafeEqual); workspace URI containment re-exported from protocol package                                                                                             | [codemap.md](packages/bridge-daemon/src/security/codemap.md)                                 |
| `packages/bridge-daemon/src/discovery/`                                | Atomic private discovery file writer (0600 perms, symlink rejection, no Windows)                                                                                                                                | [codemap.md](packages/bridge-daemon/src/discovery/codemap.md)                                |
| `packages/bridge-daemon/src/observability/`                            | Structured JSON-line logger with rate limiting, HMAC'd request IDs, session/method redaction, level filtering, token-bucket throttling                                                                          | [codemap.md](packages/bridge-daemon/src/observability/codemap.md)                            |
| `packages/bridge-daemon/src/plan/`                                     | In-memory plan store for two-phase edits: public↔adapter ID translation, TTL expiration (5 min), invalidation, atomic consume-then-release, capacity limits                                                     | [codemap.md](packages/bridge-daemon/src/plan/codemap.md)                                     |
| `packages/bridge-daemon/src/dashboard/`                                | Read-only loopback HTTP dashboard server: two-token auth (single-use launch → session), GET-only, DNS rebinding defense, serves metrics/adapters/workspaces to a local browser (ADR-0035)                       | [codemap.md](packages/bridge-daemon/src/dashboard/codemap.md)                                |
| `packages/bridge-client/src/`                                          | Shared TypeScript client: barrel exports, 10 typed error classes, reconnecting connection, inbound request types, metadata                                                                                      | [codemap.md](packages/bridge-client/src/codemap.md)                                          |
| `packages/bridge-client/src/connection/`                               | Connection establishment, reconnecting connection (exponential backoff, session restoration), bidirectional JSON-RPC engine (outbound + inbound adapter handlers, cancellation, tombstones)                     | [codemap.md](packages/bridge-client/src/connection/codemap.md)                               |
| `packages/bridge-client/src/discovery/`                                | Security-validated discovery file reader (O_NOFOLLOW, 0600 check, owner check, size bound)                                                                                                                      | [codemap.md](packages/bridge-client/src/discovery/codemap.md)                                |
| `packages/cli/src/`                                                    | CLI tool: 5 commands (daemon, status, adapters, workspaces, doctor), file-lock ownership, 7-check health engine, structured JSON output, `--dashboard` flag for local dashboard surface (ADR-0035)              | [codemap.md](packages/cli/src/codemap.md)                                                    |
| `packages/vscode-extension/src/`                                       | VS Code adapter: 21 source files, 13 of 16 routed methods (document/symbol/navigation/diagnostic/edit routes), event bridge, workspace model, daemon auto-start, symbol relocation                              | [codemap.md](packages/vscode-extension/src/codemap.md)                                       |
| `packages/conformance/src/`                                            | IDE-independent conformance rules — one implementation judging **two** captured adapters (50 tests) across workspaces, symbols, hierarchies, plans, modifications                                               | [codemap.md](packages/conformance/src/codemap.md)                                            |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/connection/` | Loopback WebSocket transport (JDK HttpClient), authenticated handshake, correlated RPC client, discovery file reader, `AdapterRouter` routing requests to handlers — fully functional                           | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/connection/codemap.md) |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/diagnostic/` | IntelliJ diagnostic mapping: severity thresholds, drop-not-truncate messages, fix mapping, analysis state — pure Kotlin, no IntelliJ types leak                                                                 | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/diagnostic/codemap.md) |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/edit/`       | Two-phase edit scheduling: `EditScheduler` (EDT write commands) and `RenamePlanRegistry` (consume-once plans, session/epoch binding, FIFO eviction)                                                             | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/edit/codemap.md)       |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/protocol/`   | Complete kotlinx.serialization mirror of IDEBP JSON Schema: types, error codes, the 27-method catalogue, notifications, IdebpJson config                                                                        | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/protocol/codemap.md)   |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/lifecycle/`  | IntelliJ lifecycle wiring: ProjectActivity (startup, off-EDT), appClosing (shutdown), projectClosing (cleanup) — public API only                                                                                | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/lifecycle/codemap.md)  |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/workspace/`  | Workspace model (stable root IDs, epoch), readiness model (dumb/smart → IDEBP), adapter registration (response verification), URI containment                                                                   | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/workspace/codemap.md)  |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/symbol/`     | Symbol handle registry (generic anchor, two namespaces), controlled relocation, `SymbolKindMapper` (extension point), `PlatformSymbolKindMapper` (IDE vocabulary→SymbolKind), `SymbolMapping` (PSI→IDEBP Draft) | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/symbol/codemap.md)     |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/document/`   | Document model (Buffer/Disk source, EditorVersionRegistry, SHA-256 contentHash authoritative, ADR-0020 editorVersion absent for disk)                                                                           | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/document/codemap.md)   |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/platform/`   | The IntelliJ boundary: 14 files (snapshot, diagnostics, navigation, rename, undo, hierarchy, TODOs, bookmarks, symbols, edits, scheduler), no IntelliJ object crosses the wire                                  | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/platform/codemap.md)   |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/service/`    | Daemon connection (APP, multi-project linking via `link`/`unlink`), readiness manager (APP), and `AdapterBackend` (785 lines) — production backend answering all 16 routed methods per project                  | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/service/codemap.md)    |
| `jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/ui/`         | Bridge tool window: `BridgeToolWindowFactory` + `BridgePanel` + `BridgePanelModel` — multi-project rows, daemon reachability, link/unlink per project (off-EDT), index health warnings (ADR-0033, ADR-0034)     | [codemap.md](jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/ui/codemap.md)         |
| `jetbrains-plugin/src/test/kotlin/com/idebridge/jetbrains/`            | Unit and integration tests for connection, protocol, workspace, symbol, document, platform, diagnostic, edit, service, ui packages                                                                              | [codemap.md](jetbrains-plugin/src/test/kotlin/com/idebridge/jetbrains/codemap.md)            |
| `integrations/serena/ide_bridge/`                                      | Serena Python backend: frozen dataclasses, NewTypes, enums, config model — skeleton, zero runtime deps, not started beyond types                                                                                | [codemap.md](integrations/serena/ide_bridge/codemap.md)                                      |
| `scripts/`                                                             | Protocol scripts: fixture validation (Ajv), type generation (JSON Schema→TypeScript with --check staleness)                                                                                                     | [codemap.md](scripts/codemap.md)                                                             |

## Phase Status

**`docs/STATUS.md` is the authority on what works.** This table says which phases were opened; that
file says what is verified, what is refused with a reason, and what is deferred by decision — and the
two answer different questions.

| Phase | Name               | Status                                                                                                                                                    |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation         | Completed                                                                                                                                                 |
| 1     | Protocol           | Completed — 27 application methods, 16 routed to adapters                                                                                                 |
| 2     | Daemon & Client    | Completed for the routed surface; heartbeat/expiration hardening remains                                                                                  |
| 3     | VS Code Adapter    | Serves 13 of 16. The three gaps are principled refusals: no scoped undo, no TODO index, no bookmarks in VS Code                                           |
| 4     | JetBrains Adapter  | Fully wired — `AdapterBackend` (758 lines) answers all 16 routed methods. Platform layer expanded to 14 files. Run in IntelliJ, PhpStorm, GoLand, PyCharm |
| 5     | Conformance        | One rule set judging two captured adapters (50 tests) across workspaces, symbols, hierarchies, plans, modifications                                       |
| 6     | Serena Integration | Not started beyond types                                                                                                                                  |
| 7     | Hardening          | Partly, and not as a phase: refusal naming, close-frame bounds, staleness and non-vacuity guards landed as the defects that needed them did               |

## Key Files

| File                                                               | Purpose                                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK.md`                                                          | Authoritative product scope (French, 1924 lines)                                                                                                                        |
| `AGENTS.md`                                                        | Development rules and validation commands                                                                                                                               |
| `docs/IMPLEMENTATION_PLAN.md`                                      | Canonical living plan with phase status, acceptance criteria, method-to-phase traceability                                                                              |
| `docs/adr/`                                                        | ADRs 0001–0028, covering protocol, routing, security, lifecycle, revisions, edits, symbols, adapter boundaries, trust, disk changes, internal API, refused refactorings |
| `packages/protocol/schemas/`                                       | 30 JSON Schema 2020-12 wire contract files                                                                                                                              |
| `packages/protocol/src/generated.ts`                               | 1822-line auto-generated TypeScript types from schemas                                                                                                                  |
| `packages/protocol/src/workspace-uri.ts`                           | 57-line canonical URI containment check shared by daemon and adapters                                                                                                   |
| `packages/bridge-daemon/src/routing/application-router.ts`         | 1525-line central request router with ID remapping, plan store, symbol/diagnostic validation                                                                            |
| `packages/bridge-daemon/src/plan/in-memory-edit-store.ts`          | 420-line plan store with ID translation, TTL expiration, invalidation, atomic consumption, reason field, full undo support                                              |
| `packages/bridge-daemon/src/observability/structured-logger.ts`    | 329-line structured logger with HMAC'd request IDs and rate limiting                                                                                                    |
| `packages/bridge-client/src/connection/reconnecting-connection.ts` | 538-line reconnection layer with exponential backoff and session restoration                                                                                            |
| `packages/bridge-client/src/connection/json-rpc-engine.ts`         | 706-line bidirectional JSON-RPC engine (outbound + inbound adapter handlers)                                                                                            |
| `packages/cli/src/run-cli.ts`                                      | 147-line CLI dispatcher with 5 commands and structured JSON error mapping                                                                                               |
| `packages/vscode-extension/src/extension.ts`                       | 361-line VS Code entry point wiring the route groups, imports capabilities from `capabilities.ts`                                                                       |
| `packages/vscode-extension/src/capabilities.ts`                    | 56-line centralized capability declarations (13 capabilities, imported by `extension.ts`)                                                                               |
| `packages/vscode-extension/src/edit-routes.ts`                     | 626-line two-phase edits: rename, reformat and quick fix (prepare/apply/discard)                                                                                        |
| `packages/vscode-extension/src/symbol-navigation-routes.ts`        | Symbol navigation and hierarchies (resolveAt, getDefinition, getReferences, getImplementations, getHierarchy)                                                           |
| `packages/vscode-extension/src/symbol-mapper.ts`                   | 672-line symbol handle registry with transient namespaces and workspace search                                                                                          |
| `jetbrains-plugin/.../connection/AdapterRouter.kt`                 | 292-line request router: routes incoming JSON-RPC to 17 backend handler methods, exception isolation                                                                    |
| `jetbrains-plugin/.../connection/WebSocketTransport.kt`            | 132-line JDK WebSocket transport with loopback enforcement and frame reassembly                                                                                         |
| `jetbrains-plugin/.../protocol/Methods.kt`                         | 373-line method catalogue, checked against the canonical schemas by `CatalogueCoverageTest`                                                                             |
| `jetbrains-plugin/.../workspace/AdapterRegistration.kt`            | Adapter registration with response verification and truthful capability refusals                                                                                        |
| `jetbrains-plugin/.../symbol/SymbolHandleRegistry.kt`              | Generic handle registry with two namespaces (DOCUMENT/TRANSIENT) and ReentrantLock                                                                                      |
| `jetbrains-plugin/.../service/AdapterBackend.kt`                   | 785-line production backend answering all 16 routed methods per project (multi-project linking, ADR-0033)                                                               |
