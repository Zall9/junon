# packages/vscode-extension/src/

## Responsibility

Maps the VS Code extension-host model to IDE Bridge Protocol (IDEBP) DTOs without exposing VS Code
internal objects on the wire. Implements the Phase 3 adapter across 21 source files: authenticated
lifecycle (connect, auto-start daemon, register, reconnect, unregister, stop), configuration
validation, host/topology detection, opaque identifier generation, payload-free safe logging,
workspace-folder-to-IDEBP mapping with epoch-based invalidation, native document reads/revisions
(in-memory and disk paths), live document/root/diagnostics/rename/delete/trust event projection
with debounce and workspace reconciliation, centralized capability declarations exported as a
single frozen map and imported at the registration site, provider-backed document symbol queries
with TOCTOU-protected revision guards and session-bound opaque handle materialization, multi-root
workspace symbol search with truthful truncation reporting and its own transient handle
namespace, symbol navigation (`resolveAt`, `getDefinition`, `getReferences`,
`getImplementations`, `getHierarchy`) with revision-bracketed resolution and fail-closed semantic
relocation, workspace-wide diagnostics snapshots with skip-don't-fail mapping and on-demand
code-action fix offers, and two-phase edits (rename, reformat, quickFix) with bounded one-shot
plans that re-verify preconditions before applying. External disk changes invalidate handles and
plans without fabricating events.

## Design Patterns

- **Entry-point boundary** (`extension.ts:34-361`): `activate()` reads current VS Code state,
  constructs 5 route groups (document, symbol, navigation, diagnostic, edit) and an event bridge,
  wires them into the lifecycle's connection configurator, then starts the lifecycle. Single-instance
  guard via module-level `activeLifecycle` (`extension.ts:31`). `deactivate()` (`extension.ts:355-361`)
  clears state and disposes the output channel. Registration imports `ADAPTER_CAPABILITIES` from
  `capabilities.ts` (`extension.ts:15`) and passes it directly (`extension.ts:343`) instead of
  declaring capabilities inline.

- **Centralized capability declarations** (`capabilities.ts:1-56`): `ADAPTER_CAPABILITIES` is a
  single frozen `Partial<Record<IDEBPApplicationMethod, Capability>>` exported as a module constant.
  Exported rather than built inline at the registration site so it can be checked against the
  protocol's routed-method list: a method missing here is not a smaller capability set, it is a
  consumer receiving no answer and no explanation. Anything unimplemented is declared `unavailable`
  with a reason instead of being omitted. The 16 entries cover 13 supported methods plus 3 explicitly
  unavailable (`workspace/searchTodos`, `workspace/listBookmarks`, `workspace/undo`). The
  `refactor/prepare` capability is declared `provider`/`syntactic` — it serves `reformat` and
  `quickFix`, which are routed by name at request time so a consumer learns which operation it asked
  for was not wired (`capabilities.ts:37-40`).

- **State machine** (`adapter-lifecycle.ts:53-263`): `AdapterLifecycle` orchestrates connect →
  auto-start daemon → register → reconnect → unregister → cleanup. Idempotent `start()`/`stop()`
  via memoized promises (`adapter-lifecycle.ts:74-82`). Registration rebuilt from current state on
  every reconnect — never cached (`adapter-lifecycle.ts:151-156`).

- **Strategy injection** (`adapter-lifecycle.ts:24-32`): `RegistrationProvider` callback supplies
  fresh `IdeRegisterRequest` params per call; `AdapterConnectionConfigurator` wires 5 route handlers
  and event bridge on connect; `AdapterRegistrationCompleted` triggers event synchronization;
  `spawnDaemon` injectable for testing.

- **Bounded config validation** (`configuration.ts:26-58`): `readAdapterConfiguration` validates all
  five settings with type checks and range bounds before returning `AdapterConfiguration`.

- **Closed-set logging** (`safe-logger.ts:3-9`): `LifecycleLogEvent` is a string-union of six events;
  logger prepends `[lifecycle]` and filters by numeric priority (`safe-logger.ts:25-39`). No
  payloads are logged.

- **Stable identity with epoch invalidation** (`workspace-model.ts:27-111`): root IDs persist
  across snapshots for unchanged URIs; `invalidateSemanticState()` increments epoch on reconnect
  (`workspace-model.ts:74-77`); `#synchronizeRoots` bumps epoch only when roots actually change
  after initialization (`workspace-model.ts:93-110`).

- **Dual-path document mapping** (`document-mapper.ts`): `mapTextDocumentAsync` captures
  in-memory editor content with `editorVersion`; `mapDiskDocumentAsync` reads on-disk content with
  no `editorVersion` (ADR-0020). Both use async SHA-256 via `webcrypto.subtle` (`document-mapper.ts:36-39`).
  URI containment enforced via `relativeUriPath` (`document-mapper.ts:176-184`).

- **Native document routes** (`document-routes.ts`): `VscodeDocumentRoutes` resolves exact URIs
  through `getWorkspaceFolder`/`openTextDocument`, enforces round-trip URI integrity before and
  after async open, normalizes errors and cancellation, and implements `document/read` plus
  `document/getRevision`. `readFromDisk` (`document-routes.ts:118-157`) reads unopened files through
  `workspace.fs.readFile` — creates no `TextDocument`, emits no event, revision carries no
  `editorVersion` (ADR-0020). `mapOpenDocument` (`document-routes.ts:159-191`) maps an already-open
  document for event notifications, returning a `MapDocumentOutcome` — the content, or one of four
  named reasons it could not be described. It returned a bare `undefined` until 2026-08-14, which
  made a lost notification indistinguishable from a document that never changed.

- **TOCTOU-protected symbol route** (`symbol-routes.ts:132-183`): `document/getSymbols` brackets
  the VS Code document-symbol provider call with exact in-memory revision captures — double
  document read with `sameRevision` comparison (`symbol-routes.ts:194-200`). Maps provider
  absence/errors canonically, materializes session-bound handles, and enforces the response ceiling.

- **Epoch-guarded search route** (`symbol-routes.ts:62-130`): `workspace/searchSymbols` resolves
  the current workspace before and after the workspace-symbol provider call and refuses to mint
  handles if the epoch moved. Opens no document — a search has no bracketed revision to capture
  (ADR-0017). Oversized results are shrunk via `fitSearchResult` and reported through `truncated`,
  never failed (`symbol-routes.ts:231-243`).

- **Bounded semantic mapping** (`symbol-mapper.ts:465-484`): `mapVscodeDocumentSymbols` maps
  hierarchical `DocumentSymbol` and flat `SymbolInformation` results into UTF-16 IDEBP locators
  with exact kind/range data, deterministic SHA-256 fingerprints, and structural bounds (5000
  symbols max, 64 depth max, 1024 char name max).

- **Truthful search mapping** (`symbol-mapper.ts:368-408`): `mapVscodeWorkspaceSymbols` is flat,
  multi-document. Out-of-root and kind-excluded hits are filtered without reporting truncation
  (scope decision, not incompleteness); in-scope hits IDEBP cannot represent — notably the
  rangeless partial locations the provider contract permits — are dropped and **do** set
  `incomplete` (`symbol-mapper.ts:346-357`). `limit` applies after filtering.

- **Opaque handle registry — two namespaces** (`symbol-mapper.ts:142-340`):
  `VscodeSymbolHandleRegistry` mints `sym_`-prefixed 144-bit IDs, enforces capacity (20000
  default), and invalidates per-document or globally. `materialize` (`symbol-mapper.ts:185-209`)
  replaces a document's tree atomically via stage-then-commit. `materializeTransient`
  (`symbol-mapper.ts:216-253`) puts individual results — search hits and point resolutions — in
  bounded FIFO generations (max 5, `MAX_TRANSIENT_GENERATIONS`), evicted oldest-first, so
  producing one never revokes handles a document already handed out. `resolve`
  (`symbol-mapper.ts:167-183`) validates adapter/session/epoch ownership before returning a record.

- **Fail-closed relocation** (`symbol-relocation.ts:29-54`): matches a stale locator on name +
  kind + optional `containerName` inside its own document, using the selection range only to break
  ties. Zero matches → `STALE_SYMBOL`; several → `AMBIGUOUS_SYMBOL` with up to 32 candidates.
  Deliberately does **not** match the fingerprint, which encodes position and fails for any symbol
  that moved (ADR-0018 amends ADR-0003). `findSymbolAtPosition` (`symbol-relocation.ts:90-101`)
  finds the innermost symbol whose declaration range contains a position.

- **Navigation routes** (`symbol-navigation-routes.ts:69-93`): `VscodeSymbolNavigationRoutes`
  registers `resolveAt` + 3 lookups (`getDefinition`, `getReferences`, `getImplementations`) +
  `getHierarchy`. `resolveAt` finds the innermost symbol containing a position under the revision
  bracket; the three lookups resolve a handle or relocate, then query the fixed VS Code provider
  command at the symbol's selection range and map `Location`/`LocationLink` results filtered to
  registered roots. Out-of-scope filtering does not set `truncated` (ADR-0018).

- **Hierarchy route** (`symbol-navigation-routes.ts:143-154`): `symbol/getHierarchy` shares the
  `#attachLookup` body deliberately — the response is `locations + truncated`, so it inherits the
  same root filtering and daemon-side checks. VS Code's call and type hierarchies are two-phase
  (prepare an item at a position, then ask that item for its neighbours); the adapter hides both
  phases behind a single `provideHierarchy` call (`symbol-navigation-routes.ts:41-45`). The protocol
  asks for one step, and a consumer never learns which of two APIs answered. `#onIdentifier`
  (`symbol-navigation-routes.ts:168-182`) refines a coarse search-handle position onto the
  declaration's name via an extra document-symbol query, because `prepareCallHierarchy` answers
  nothing from column 0 — without this, a consumer holding a search handle would receive an empty
  hierarchy and no indication why.

- **executeAtPosition helper** (`extension.ts:69-78`): abstracts
  `vscode.commands.executeCommand` + `Uri.parse` + `Position` into a single function used by
  `provideDefinition`, `provideReferences`, `provideImplementations`, and `provideHierarchy`.
  The concrete provider injected from `extension.ts` implements `VscodeNavigationProviderHost`
  (interface in `symbol-navigation-routes.ts:28-46`).

- **provideHierarchy inline implementation** (`extension.ts:102-143`): 42-line provider callback
  implementing VS Code's two-phase hierarchy API (prepare item → ask neighbours). Distinguishes
  call hierarchy (`callers`/`callees`) from type hierarchy (`supertypes`/`subtypes`) at `:106`. The
  interface is in `symbol-navigation-routes.ts`; the concrete provider is injected from
  `extension.ts`.

- **Workspace-wide diagnostics** (`diagnostic-routes.ts:46-108`): `diagnostics/getSnapshot`
  covers every in-workspace document VS Code reports diagnostics for. An open document supplies
  its exact buffer revision; a closed one is read from disk and its revision carries no
  `editorVersion` (ADR-0020). An out-of-root URI in an explicit list fails the request
  (`diagnostic-routes.ts:63-68`). Capped at `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS`; oversized responses
  are shrunk by dropping whole documents via `fitSnapshot` (`diagnostic-routes.ts:210-223`).
  When the consumer names specific documents (`documentUris` is present), fixes are fetched
  on demand: `#withAvailableFixes` (`diagnostic-routes.ts:151-176`) calls
  `vscode.executeCodeActionProvider` per diagnostic's range, capped at `MAX_DIAGNOSTICS_WITH_FIXES`
  (20, `diagnostic-mapper.ts:174`) — each entry is a provider round trip, and a project-wide sweep
  would exhaust the daemon's route timeout. A snapshot without `documentUris` omits fix offers
  rather than spending the request budget on documents nobody asked about.

- **Non-destructive diagnostic mapping** (`diagnostic-mapper.ts:37-57`): skips entries IDEBP
  cannot represent rather than failing the snapshot, drops related information outside the
  workspace (`diagnostic-mapper.ts:88-105`), and never clips a message — payload size is
  controlled by dropping whole documents. Capped at `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT`.
  Code-action fix mapping (`diagnostic-mapper.ts:174-224`): `mapCodeActions` extracts only
  edit-backed actions — command-backed actions run arbitrary IDE behaviour and are dropped.
  Each fix gets a stable FNV-1a 32-bit `fixId` derived from `kind + title`
  (`diagnostic-mapper.ts:187-194`), so a consumer can pass it back in a later request. Duplicate
  identifiers are dropped (`diagnostic-mapper.ts:219-220`). The adapter re-derives the fixId at
  apply time and refuses when nothing matches, so a superseded offer fails closed.

- **Shared symbol resolution** (`symbol-target.ts:42-154`): `VscodeSymbolTargetResolver.resolve`
  provides one path from a consumer symbol reference to a document position — live handle, else
  fail-closed relocation — used by both navigation and rename, so a symbol that can be navigated
  to can also be renamed. `documentSymbols` (`symbol-target.ts:107-153`) runs the revision bracket
  (ADR-0016) shared by both consumers.

- **Two-phase edits** (`edit-routes.ts:88-596`): three prepare routes share the same bounded
  one-shot plan store. `refactor/prepareRename` (`edit-routes.ts:311-445`) validates trust,
  resolves the symbol, asks the provider whether the position is renameable, bounds the resulting
  edit (500 docs, 10000 edits), and records one revision precondition per affected document.
  `refactor/prepare` (`edit-routes.ts:144-216`) dispatches by operation: `reformat` fetches
  formatter edits via `provideFormatEdits` (computed, not applied — preparing is side-effect free)
  and declares `guarantee: "syntactic"`; `quickFix` (`edit-routes.ts:226-309`) resolves a chosen
  `fixId` by re-querying `vscode.executeCodeActionProvider` at prepare time and re-deriving the
  identifier, so a superseded offer fails closed rather than applying whatever now occupies that
  slot. Both produce a plan with a single-document revision precondition. `workspace/applyPlan`
  (`edit-routes.ts:447-523`) re-verifies every precondition immediately before writing — the daemon
  never checks content — then applies, saves, and hashes after the save settles so format-on-save
  is reflected (`edit-routes.ts:496-507`). Plans are session-bound, expiring (2-minute lifetime,
  `PLAN_LIFETIME_MS`), capped (32 live, `MAX_LIVE_PLANS`), dropped on any covered document change
  (`edit-routes.ts:126-130`), and removed before the edit runs so a retry cannot replay them
  (`edit-routes.ts:547-549`). `workspace/undo` has no handler: VS Code cannot revert an applied
  edit (ADR-0021). Trust is checked at both phases (`edit-routes.ts:582-595`).

- **Observable-only file events** (`event-bridge.ts:155-193`): rename and delete gestures are
  projected as `document/renamed` / `document/deleted`. A folder gesture — VS Code fires one
  event for the whole folder — is expanded onto the open documents beneath it, the only children
  identifiable truthfully (`event-bridge.ts:278-293`). Changes made outside the editor emit no VS
  Code event and so produce none here (ADR-0022).

- **Invalidation-only watcher** (`extension.ts:291-300`): a `createFileSystemWatcher` invalidates
  symbol handles and prepared plans for externally changed URIs. It emits no notification: a
  watcher cannot tell a rename from a delete-plus-create, and guessing would invent a
  relationship never observed (ADR-0022).

- **Monotonic trust** (`event-bridge.ts:261-275`): `onDidGrantWorkspaceTrust` emits
  `workspace/trustChanged`; the daemon updates that one field. Nothing else is invalidated.
  VS Code cannot revoke trust without a window reload, which restarts the extension host and
  re-registers from scratch.

- **Debounced diagnostics events** (`event-bridge.ts:201-213`): `diagnostics/changed` is
  debounced per-URI (75ms, same as document changes) and emitted only for documents the editor
  holds open — a closed document has no editor version to report truthfully (ADR-0019). Capped at
  `MAX_DEBOUNCED_DOCUMENTS`.

- **Serialized event projection** (`event-bridge.ts:75-416`): `VscodeEventBridge` serializes all
  notifications via a promise chain (`#serialize`, `event-bridge.ts:411-415`), debounces
  `document/changed` at 75ms with 1024-document overflow protection (`event-bridge.ts:314-330`),
  yields to the extension host every 16 documents during synchronization
  (`event-bridge.ts:111`), and maps workspace root/open/close transitions to canonical
  notifications.

- **Exact child-handle supervision** (`daemon-process.ts:19-43`): spawns daemon with
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, no shell, no PATH lookup. `stop()` sends SIGTERM
  then SIGKILL after 3s timeout (`daemon-process.ts:66-85`).

- **Bundled CLI delegate** (`daemon-child.ts:1-11`): 11-line entry point that forwards argv to
  `@ide-bridge/cli`'s `runCli`; bundled separately as `dist/daemon-child.js` by esbuild.

- **Factory with overload** (`identifiers.ts:7-12`): `createOpaqueIdentifier` uses overloads to
  return typed `AdapterId`/`RootId`/`WorkspaceId` from a single crypto-random base64url generator.

## Key Types

```typescript
// adapter-lifecycle.ts:23-32
type RegistrationReason = "initial" | "reconnect";
type RegistrationProvider = (reason: RegistrationReason) => IdeRegisterRequest["params"];
type AdapterConnectionConfigurator = (
  connection: ReconnectingBridgeConnection,
) => (() => void) | undefined;
type AdapterRegistrationCompleted = (
  connection: Pick<AuthenticatedBridgeConnection, "notify">,
  reason: RegistrationReason,
  registration: IdeRegisterRequest["params"],
) => void | Promise<void>;

// adapter-lifecycle.ts:34-46
interface AdapterLifecycleOptions {
  configuration: AdapterConfiguration;
  topology: IDEBPEndpointTopology;
  daemonScriptPath: string;
  registration: RegistrationProvider;
  configureConnection?: AdapterConnectionConfigurator;
  registrationCompleted?: AdapterRegistrationCompleted;
  logger: SafeLifecycleLogger;
  platform?: NodeJS.Platform;
  spawnDaemon?: (options: SpawnDaemonOptions) => OwnedDaemonProcess;
  initialConnectTimeoutMs?: number;
  startupTimeoutMs?: number;
}

// configuration.ts:10-22
interface AdapterConfiguration {
  autoStartDaemon: boolean;
  discoveryFile: string;
  endpointOverride?: string; // validated loopback endpoint, omitted when empty
  logLevel: ExtensionLogLevel; // "debug" | "error" | "info" | "warn"
  providerTimeoutMs: number; // 100–300000 ms
}

// safe-logger.ts:3-23
type LifecycleLogEvent =
  | "activation-failed"
  | "adapter-connected"
  | "adapter-reconnecting"
  | "adapter-stopped"
  | "daemon-autostarted"
  | "registration-restored";
interface SafeLifecycleLogger {
  debug(event: LifecycleLogEvent): void;
  error(event: LifecycleLogEvent): void;
  info(event: LifecycleLogEvent): void;
  warn(event: LifecycleLogEvent): void;
}

// workspace-model.ts:11-24
interface VscodeWorkspaceFolderLike {
  name: string;
  uri: VscodeUriLike;
}
interface WorkspaceSnapshotOptions {
  name?: string;
  trusted: boolean;
}

// document-mapper.ts:11-30
interface VscodeDocumentUriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  toString(): string;
}
interface VscodeTextDocumentLike {
  readonly uri: VscodeDocumentUriLike;
  readonly version: number;
  readonly languageId: string;
  readonly isDirty: boolean;
  getText(): string;
}
interface DocumentMappingContext {
  workspace: Workspace;
  root: WorkspaceRoot;
  rootUri: VscodeDocumentUriLike;
}

// document-routes.ts:21-33
interface VscodeDocumentHost {
  parseUri(value: string): VscodeDocumentUriLike;
  getWorkspaceFolder(uri: VscodeDocumentUriLike): VscodeWorkspaceFolderLike | undefined;
  openTextDocument(uri: VscodeDocumentUriLike): Promise<VscodeTextDocumentLike>;
  readFile?(uri: VscodeDocumentUriLike): Promise<string>; // no TextDocument, no event
}
interface VscodeDocumentRoutesOptions {
  host: VscodeDocumentHost;
  workspaceModel: VscodeWorkspaceModel;
  currentWorkspace(): Workspace | undefined;
}

// event-bridge.ts:10-15, 32-73
const DOCUMENT_CHANGE_DEBOUNCE_MS = 75;
const MAX_DEBOUNCED_DOCUMENTS = 1_024;
const MAX_DIAGNOSTIC_EVENT_URIS = 1_024;
const MAX_FILE_EVENT_ENTRIES = 1_024;
interface VscodeEventHost {
  readonly textDocuments: readonly VscodeTextDocumentLike[];
  onDidOpenTextDocument(listener): VscodeDisposableLike;
  onDidChangeTextDocument(listener): VscodeDisposableLike;
  onDidSaveTextDocument(listener): VscodeDisposableLike;
  onDidCloseTextDocument(listener): VscodeDisposableLike;
  onDidChangeWorkspaceFolders(listener): VscodeDisposableLike;
  onDidChangeDiagnostics?(listener): VscodeDisposableLike; // optional
  onDidRenameFiles?(listener): VscodeDisposableLike; // optional
  onDidDeleteFiles?(listener): VscodeDisposableLike; // optional
  onDidGrantWorkspaceTrust?(listener): VscodeDisposableLike; // optional
}
interface VscodeEventBridgeOptions {
  host: VscodeEventHost;
  documentRoutes: VscodeDocumentRoutes;
  currentWorkspaces(): [] | [Workspace];
  documentChanged?(uri: string): void;
  documentRenamed?(previousUri: string, currentUri: string): void;
  documentDeleted?(uri: string): void;
  workspaceProjectionChanged?(workspace: Workspace | undefined): void;
  documentEventDropped?(method: DroppableNotificationMethod, reason: DocumentEventDropReason): void;
}
// A notification that never leaves the extension names itself. Eight reasons, no payload:
//   no-workspace | unsupported-scheme | outside-workspace | no-matching-root | unmappable
//                                                                     (from mapOpenDocument)
//   no-notifier | disposed | send-failed                              (decided by the bridge)
// `unsupported-scheme` is separate on purpose: every run drops chatSessionInput:input-0, and
// sharing a name with outside-workspace would bury a real file in permanent editor noise.
type DocumentEventDropReason = MapDocumentSkip | "disposed" | "no-notifier" | "send-failed";

// symbol-mapper.ts:15-20, 82-135
const MAX_DOCUMENT_SYMBOLS = 5_000;
const MAX_SYMBOL_DEPTH = 64;
const MAX_SYMBOL_TEXT_LENGTH = 1_024;
const DEFAULT_MAX_HANDLES = 20_000;
const MAX_SEARCH_SCAN = 20_000;
const MAX_TRANSIENT_GENERATIONS = 5;
interface SymbolDraft {
  locator: SymbolLocator;
  range: Range;
  children: SymbolDraft[];
}
interface HandleRecord {
  kind: "document" | "transient";
  workspaceId: WorkspaceId;
  documentUri: string;
  editorVersion?: number; // absent for search hits (ADR-0017)
  locator: SymbolLocator;
}
interface MaterializeSymbolContext {
  adapterId: AdapterId;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  documentUri: string;
  editorVersion?: number; // absent for on-disk content (ADR-0020)
  workspaceEpoch: number;
}
interface MaterializeTransientContext extends ResolveHandleContext {
  editorVersion?: number; // supplied only when caller bracketed a revision
}
interface WorkspaceSearchMappingOptions {
  isWithinWorkspace(documentUri: string): boolean;
  kinds?: ReadonlySet<SymbolKind>;
  limit: number;
}
interface WorkspaceSearchMapping {
  drafts: SymbolDraft[];
  incomplete: boolean; // capped, over-scanned, or in-scope but unrepresentable
}

// symbol-routes.ts:28-39
interface VscodeSymbolProviderHost {
  provideDocumentSymbols(uri: string): Promise<unknown>;
  provideWorkspaceSymbols(query: string): Promise<unknown>;
}
interface VscodeSymbolRoutesOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  provider: VscodeSymbolProviderHost;
  currentWorkspace(): Workspace | undefined;
  handles?: VscodeSymbolHandleRegistry;
}

// symbol-navigation-routes.ts:28-46
interface VscodeNavigationProviderHost {
  provideDocumentSymbols(uri: string): Promise<unknown>;
  provideDefinition(uri: string, position: Position): Promise<unknown>;
  provideReferences(uri: string, position: Position): Promise<unknown>;
  provideImplementations(uri: string, position: Position): Promise<unknown>;
  // Two-phase: prepare an item at a position, then ask that item for its neighbours.
  // The adapter hides both phases; a consumer never learns which of two APIs answered.
  provideHierarchy(
    uri: string,
    position: Position,
    relation: "callers" | "callees" | "supertypes" | "subtypes",
  ): Promise<unknown>;
}
interface VscodeSymbolNavigationRoutesOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  provider: VscodeNavigationProviderHost;
  currentWorkspace(): Workspace | undefined;
  handles: VscodeSymbolHandleRegistry;
}

// symbol-relocation.ts:19-27
type AmbiguousCandidates = [SymbolLocator, SymbolLocator, ...SymbolLocator[]];
type RelocationOutcome =
  | { kind: "resolved"; draft: SymbolDraft }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: AmbiguousCandidates };

// symbol-target.ts:30-40
interface SymbolTargetResolverOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  handles: VscodeSymbolHandleRegistry;
  provideDocumentSymbols(uri: string): Promise<unknown>;
}
interface ResolvedSymbolTarget {
  documentUri: string;
  selectionRange: Range;
}

// diagnostic-mapper.ts:17-30
interface VscodeDiagnosticLike {
  readonly range: unknown;
  readonly message: unknown;
  readonly severity?: unknown;
  readonly source?: unknown;
  readonly code?: unknown;
  readonly relatedInformation?: unknown;
}
interface DiagnosticMapping {
  diagnostics: Diagnostic[];
  truncated: boolean; // per-document ceiling exceeded
}

// diagnostic-routes.ts:22-42
interface VscodeDiagnosticHost {
  /** All resources VS Code currently reports diagnostics for, open or not. */
  allDiagnostics(): readonly (readonly [{ toString(): string }, unknown])[];
  diagnosticsFor(uri: string): unknown;
  /** `vscode.executeCodeActionProvider` for one diagnostic's range — computed on demand. */
  provideCodeActions(uri: string, range: unknown): Promise<unknown>;
  /** URIs of the text documents the editor currently holds open. */
  openDocumentUris(): readonly string[];
}
interface VscodeDiagnosticRoutesOptions {
  host: VscodeDiagnosticHost;
  documentRoutes: VscodeDocumentRoutes;
  currentWorkspace(): Workspace | undefined;
  now?: () => Date;
}

// edit-routes.ts:28-75
const MAX_PLAN_DOCUMENTS = 500;
const MAX_PLAN_EDITS = 10_000;
const PLAN_LIFETIME_MS = 120_000; // 2 minutes
const MAX_LIVE_PLANS = 32;
interface VscodeEditHost {
  prepareRename(uri: string, position): Promise<unknown>;
  provideRenameEdits(uri: string, position, newName: string): Promise<unknown>;
  /** `executeFormatDocumentProvider`, wrapped as a workspace edit — computed, not applied. */
  provideFormatEdits(uri: string): Promise<unknown>;
  /** `executeCodeActionProvider` for a range — re-queried at prepare time, never remembered. */
  provideCodeActions(uri: string, range: unknown): Promise<unknown>;
  describeEdit(edit: unknown): readonly (readonly [string, number])[];
  applyEdit(edit: unknown): Promise<boolean>;
  save(uri: string): Promise<boolean>;
}
interface StoredPlan {
  plan: EditPlan;
  edit: unknown; // stored VS Code WorkspaceEdit
  sessionId: SessionId;
  workspaceEpoch: number;
  expiresAt: number;
  uris: string[];
}

// daemon-process.ts:6-15
interface OwnedDaemonProcess {
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}
interface SpawnDaemonOptions {
  scriptPath: string;
  discoveryFile: string;
  logLevel: ExtensionLogLevel;
}

// topology.ts:5-11
interface VscodeTopologyEnvironment {
  appHost: string;
  remoteName?: string;
  workspaceFolders?: readonly (VscodeWorkspaceFolderLike & { uri: { scheme: string } })[];
}
```

## Key Functions

```typescript
// extension.ts:34
async function activate(context: vscode.ExtensionContext): Promise<void>
// Creates output channel, reads config, generates adapter ID, builds workspace model, 5 route
// groups (document, symbol, navigation, diagnostic, edit), symbol target resolver, event bridge
// (with invalidation callbacks for symbols + plans), file-system watcher, and topology. Constructs
// AdapterLifecycle with configureConnection (attaches 5 routes + event bridge), registrationCompleted
// (event sync), and registration (imports ADAPTER_CAPABILITIES from capabilities.ts, invalidates on
// reconnect). Guards against double-activation.

// extension.ts:355
async function deactivate(): Promise<void>
// Clears activeLifecycle, awaits lifecycle.stop(), disposes output channel.

// adapter-lifecycle.ts:74 / :79
start(): Promise<void>   // memoized via #startTask — starts connect/register cycle once
stop(): Promise<void>    // memoized via #stopTask — sets #stopping, unregisters, cleans up

// adapter-lifecycle.ts:113
async #connectOrStartDaemon(): Promise<ReconnectingBridgeConnection>
// Tries connect; on failure, if autoStartDaemon, asserts preconditions, spawns owned daemon,
// then polls connect until startup timeout (default 10s, retry 100ms).

// adapter-lifecycle.ts:161
async #assertAutoStartAllowed(): Promise<void>
// Rejects auto-start when endpointOverride set, on win32, on non-local topology, or when
// discovery file exists but is invalid (non-ENOENT error).

// adapter-lifecycle.ts:183
async #register(connection, reason): Promise<IdeRegisterRequest["params"]>
// Calls registration provider, asserts adapterId stability across lifecycle, sends
// "ide/register" with 5s timeout, validates response via assertRegistrationResponse.

// adapter-lifecycle.ts:265
function assertRegistrationResponse(request, response): void
// Verifies daemon echoed adapterId and all workspace IDs with matching adapterId ownership.

// configuration.ts:26
function readAdapterConfiguration(configuration: ConfigurationLike, environment?): AdapterConfiguration
// Reads five VS Code settings; validates types and ranges; resolves discovery file path via
// @ide-bridge/cli; validates manual endpoint as loopback via assertIDEBPLoopbackEndpoint.

// topology.ts:13
function createVscodeTopology(environment: VscodeTopologyEnvironment): IDEBPEndpointTopology
// Maps appHost + remoteName to hostKind (web/local/remote-workspace); maps remoteName to
// environmentKind (local/wsl/dev-container/codespace/ssh/unknown); collects unique URI schemes.

// workspace-model.ts:50
snapshot(folders, options): [] | [Workspace]
// Synchronizes root IDs (deletes removed, keeps stable IDs for unchanged URIs), bumps epoch on
// change, returns single Workspace DTO or empty array for zero folders.

// workspace-model.ts:74
invalidateSemanticState(): number
// Increments #workspaceEpoch — called on reconnect so daemon sees fresh state.

// document-mapper.ts:32 / :36
function hashInMemoryContent(text: string): `sha256:${string}`
async function hashInMemoryContentAsync(text: string): Promise<`sha256:${string}`>
// UTF-8 SHA-256 hex digest with "sha256:" prefix. Sync uses createHash; async uses webcrypto.subtle.

// document-mapper.ts:63 / :73
async function mapDiskDocumentAsync(uri, text, context): Promise<DocumentContent>
async function mapTextDocumentAsync(document, context): Promise<DocumentContent>
// mapDiskDocumentAsync: no editorVersion, isDirty=false (ADR-0020). mapTextDocumentAsync: validates
// version, root membership, URI containment; returns DocumentContent with revision.

// document-routes.ts:63
async read(params: DocumentTargetParams, signal?: AbortSignal): Promise<DocumentContent>
// Resolves workspace by ID, parses URI (round-trip verified), finds workspace folder, opens
// document (round-trip URI re-verified after async), maps to DocumentContent. All errors non-retryable.

// document-routes.ts:118
async readFromDisk(uri: string, signal?: AbortSignal): Promise<DocumentContent | undefined>
// Reads unopened file through host.readFile; creates no TextDocument, emits no event. Returns
// undefined when URI is not readable inside a registered root.

// document-routes.ts:170
async mapOpenDocument(document: VscodeTextDocumentLike): Promise<MapDocumentOutcome>
// Maps an already-open document for event notification. Never throws: answers with the content, or
// with `skipped` naming which of the four conditions failed.

// event-bridge.ts:98
async synchronize(notifier, registeredWorkspaces: readonly Workspace[]): Promise<void>
// Starts listeners, serializes workspace reconciliation + open-document projection. Yields
// to extension host every 16 documents via setImmediate.

// symbol-mapper.ts:465
function mapVscodeDocumentSymbols(value: unknown, documentUri: string): SymbolDraft[] | undefined
// Validates provider result is array, enforces 5000-symbol cap, dispatches to DocumentSymbol or
// SymbolInformation mapper. Returns undefined for null/undefined (capability unavailable).

// symbol-mapper.ts:368
function mapVscodeWorkspaceSymbols(value, options): WorkspaceSearchMapping | undefined
// Flat multi-document mapping. Filters out-of-root and kind-excluded hits silently; reports
// capped, over-scanned, and unrepresentable in-scope hits through `incomplete`. Returns undefined
// for null/undefined (capability unavailable); [] is a successful empty result.

// symbol-mapper.ts:185
VscodeSymbolHandleRegistry.materialize(drafts, context): IDEBPSymbol[]
// Counts drafts, reserves capacity (evicting old transient generations first), stages handles in a
// temp map, invalidates previous document handles, commits. Assigns sym_-prefixed 144-bit IDs
// with validUntilEpoch bound to workspaceEpoch.

// symbol-mapper.ts:216
VscodeSymbolHandleRegistry.materializeTransient(drafts, context): IDEBPSymbol[]
// Same minting, own FIFO generation (max 5). Never replaces a document's handle set. Records
// carry no editorVersion unless the caller bracketed a revision; a reverse per-document index
// keeps them invalidated by document changes.

// symbol-mapper.ts:167
VscodeSymbolHandleRegistry.resolve(handle, context): ResolvedHandle | undefined
// Validates adapter/session/epoch ownership. Returns undefined for any handle not minted in this
// physical session and epoch — caller falls back to locator relocation.

// symbol-routes.ts:52
VscodeSymbolRoutes.attach(connection): () => void
// Registers document/getSymbols + workspace/searchSymbols. Returns disposer.

// symbol-navigation-routes.ts:76
VscodeSymbolNavigationRoutes.attach(connection): () => void
// Registers symbol/resolveAt + 3 lookups (getDefinition, getReferences, getImplementations)
// + symbol/getHierarchy. Returns disposer.

// symbol-navigation-routes.ts:352
function mapProviderLocations(value, isWithinWorkspace): { locations, truncated }
// Maps Location[] or LocationLink[] provider output. Filters out-of-root (scope decision, does
// not set truncated). Ceiling applied after filtering via IDEBP_MAX_SYMBOL_LOCATIONS.

// symbol-relocation.ts:29
function relocateSymbol(locator, drafts): RelocationOutcome
// Semantic-field matching (name, kind, optional containerName). Selection range breaks ties.
// Zero → not-found, several → ambiguous (max 32 candidates).

// symbol-relocation.ts:90
function findSymbolAtPosition(drafts, position): SymbolDraft | undefined
// Finds the innermost symbol whose declaration range contains the position.

// symbol-target.ts:49
VscodeSymbolTargetResolver.resolve(workspace, params, sessionId, signal): Promise<ResolvedSymbolTarget>
// Handle fast-path → fail-closed locator relocation. Shared by navigation and rename.

// symbol-target.ts:107
VscodeSymbolTargetResolver.documentSymbols(target, signal): Promise<{ document, drafts }>
// Runs the document symbol provider bracketed by exact revision captures (ADR-0016). Shared by
// resolve and navigation #resolveTarget.

// diagnostic-mapper.ts:37
function mapVscodeDiagnostics(value, isWithinWorkspace): DiagnosticMapping
// Maps one document's diagnostics. Skips unrepresentable entries (sets truncated). Capped at
// IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT. Never clips a message.

// diagnostic-mapper.ts:174
const MAX_DIAGNOSTICS_WITH_FIXES: 20  // bounded prefix — each entry is a provider round trip

// diagnostic-mapper.ts:187
function codeActionFixId(kind: string, title: string): string
// Stable FNV-1a 32-bit hash of `${kind} ${title}`. A consumer passes this back in a quickFix
// request; the adapter re-derives it at apply time and refuses when nothing matches.

// diagnostic-mapper.ts:203
function mapCodeActions(value: unknown): { fixId: string; title: string }[]
// Extracts edit-backed code actions only. Command-backed actions are dropped (arbitrary IDE
// behaviour). Capped at MAX_FIXES_PER_DIAGNOSTIC (32). Duplicate fixIds dropped.

// diagnostic-routes.ts:55
VscodeDiagnosticRoutes.attach(connection): () => void
// Registers diagnostics/getSnapshot. Open document → exact buffer revision; closed → disk read
// (no editorVersion). Out-of-root URI in explicit list fails the request. When documentUris is
// present, fetches code-action fixes per diagnostic (capped at MAX_DIAGNOSTICS_WITH_FIXES).

// edit-routes.ts:103
VscodeEditRoutes.attach(connection): () => void
// Registers refactor/prepareRename + refactor/prepare (reformat, quickFix) +
// workspace/applyPlan + workspace/discardPlan. Returns disposer that clears all plans.

// edit-routes.ts:126
VscodeEditRoutes.invalidateDocument(uri: string): void
// Drops any plan touching a document that changed: its preconditions can no longer hold.

// edit-routes.ts:144
async #prepare(params, context): Promise<{ plan: EditPlan }>
// Generic prepare entry point. Dispatches by operation: quickFix → #prepareQuickFix;
// reformat → fetches formatter edits (provideFormatEdits), declares syntactic guarantee;
// anything else → CAPABILITY_UNAVAILABLE by name.

// edit-routes.ts:226
async #prepareQuickFix(params, context): Promise<{ plan: EditPlan }>
// Re-queries code-action provider at prepare time, re-derives fixId from kind+title, matches
// against the consumer's fixId. No match → PRECONDITION_FAILED (offer gone/stale). Declares
// semantic guarantee.

// edit-routes.ts:311
async #prepareRename(params, context): Promise<{ plan: EditPlan }>
// Resolves symbol → prepareRename → provideRenameEdits → bounds (500 docs, 10000 edits) →
// root containment → revision preconditions → stores plan (2-min expiry, max 32 live).

// edit-routes.ts:447
async #applyPlan(params, context): Promise<ModificationResult>
// Re-verifies every precondition → applies edit → saves each file → hashes after save settles
// → invalidates handles for touched URIs. Optional post-apply diagnostics.

// daemon-process.ts:19
function spawnOwnedDaemon(options: SpawnDaemonOptions): OwnedDaemonProcess
// Validates absolute path, spawns process.execPath with ELECTRON_RUN_AS_NODE=1, no shell;
// returns handle with exited promise and idempotent stop().

// identifiers.ts:10
function createOpaqueIdentifier(prefix: IdentifierPrefix): string
// 18 random bytes (144 bits) → base64url, prefixed with adapter_/root_/ws_.
```

## Data & Control Flow

```
VS Code activates extension
  │
  ├─ extension.ts:activate()
  │    ├─ readAdapterConfiguration() → AdapterConfiguration (5 validated settings)
  │    ├─ createOpaqueIdentifier("adapter_") → AdapterId
  │    ├─ new VscodeWorkspaceModel(adapterId) → one workspace per window
  │    ├─ new VscodeDocumentRoutes({ host, workspaceModel, currentWorkspace })
  │    ├─ new VscodeSymbolHandleRegistry()
  │    ├─ new VscodeSymbolRoutes({ adapterId, documentRoutes, handles, provider, currentWorkspace })
  │    ├─ new VscodeSymbolNavigationRoutes({ adapterId, documentRoutes, handles, provider, currentWorkspace })
  │    ├─ new VscodeDiagnosticRoutes({ host, documentRoutes, currentWorkspace })
  │    ├─ new VscodeSymbolTargetResolver({ adapterId, documentRoutes, handles, provideDocumentSymbols })
  │    ├─ new VscodeEditRoutes({ adapterId, documentRoutes, handles, resolver, host, currentWorkspace })
  │    ├─ new VscodeEventBridge({ host, documentRoutes, currentWorkspaces,
  │    │      documentChanged → symbolRoutes.invalidateDocument + editRoutes.invalidateDocument,
  │    │      documentRenamed → invalidateForUri (both URIs),
  │    │      documentDeleted → invalidateForUri,
  │    │      workspaceProjectionChanged → symbolRoutes.invalidateAll + editRoutes.invalidateAll })
  │    ├─ createFileSystemWatcher("**/*") → onExternalChange → invalidateForUri (symbols + plans)
  │    ├─ createVscodeTopology() → IDEBPEndpointTopology
  │    └─ new AdapterLifecycle({ configuration, topology, daemonScriptPath, registration, logger,
  │         configureConnection, registrationCompleted })
  │         │
  │         ├─ start() → #connectOrStartDaemon()
  │         │    ├─ connectReconnectingBridgeClientFromDiscoveryFile(discoveryFile, ...)
  │         │    │    └─ on failure + autoStartDaemon:
  │         │    │         ├─ #assertAutoStartAllowed() (local-only, no endpoint override)
  │         │    │         ├─ spawnOwnedDaemon({ scriptPath: dist/daemon-child.js, ... })
  │         │    │         │    └─ daemon-child.ts → runCli(["daemon","--discovery-file",...])
  │         │    │         └─ poll connect until startup timeout (10s, 100ms retry)
  │         │    │
   │         ├─ configureConnection(connection)
   │         │    ├─ eventBridge.setLiveNotifier(connection)
   │         │    ├─ documentRoutes.attach()    → document/read + document/getRevision
   │         │    ├─ symbolRoutes.attach()      → document/getSymbols + workspace/searchSymbols
   │         │    ├─ navigationRoutes.attach()   → symbol/resolveAt + getDefinition + getReferences + getImplementations + getHierarchy
   │         │    ├─ diagnosticRoutes.attach()   → diagnostics/getSnapshot
   │         │    ├─ editRoutes.attach()         → refactor/prepareRename + refactor/prepare (reformat, quickFix) + workspace/applyPlan + workspace/discardPlan
   │         │    └─ returns disposer (detach 5 routes in reverse, invalidateAll, dispose events)
   │         │
   │         ├─ #register(connection, "initial")
   │         │    ├─ registration("initial") → IdeRegisterRequest params
   │         │    │    ├─ adapterId, name, version, ideKind="vscode", ideVersion
   │         │    │    ├─ positionEncodings: ["utf-16"]
   │         │    │    ├─ capabilities: ADAPTER_CAPABILITIES imported from capabilities.ts (see Common Gotchas #1)
   │         │    │    └─ workspaces: workspaceModel.snapshot(folders, {name, trusted})
   │         │    └─ connection.request("ide/register", params, {timeoutMs: 5000})
  │         │
  │         └─ registrationCompleted(connection, "initial", registration)
  │              └─ eventBridge.synchronize(connection, registration.workspaces)
  │                   ├─ #reconcileWorkspace → workspace/opened | workspace/closed | workspace/rootsChanged
  │                   └─ project all open documents → document/opened (yield every 16 docs)
  │
  ├─ on reconnect: restoreSession callback → #register(candidate, "reconnect")
  │    ├─ registration("reconnect"):
  │    │    ├─ workspaceModel.invalidateSemanticState() → epoch++
  │    │    └─ symbolRoutes.invalidateAll() → clear all handles
  │    └─ registrationCompleted → eventBridge.synchronize (re-projects current state)
  │
  └─ stop() → #stopInternal()
       ├─ #stopping = true
       ├─ connection.request("ide/unregister", {adapterId}) [best-effort]
       └─ #cleanup() → dispose configured connection, close connection, stop daemon
```

**Document request flow (open document):**

```
document/read or document/getRevision
  → assertNotCancelled → resolve workspace by ID → parse URI → round-trip verify
  → getWorkspaceFolder → rootFor → validate root membership → openTextDocument
  → round-trip verify again → mapTextDocumentAsync → assertNotCancelled → assertResponseFits
```

**Document symbol flow (TOCTOU protected, ADR-0016):**

```
document/getSymbols
  → documentRoutes.read() [capture #1: revision R1]
  → assertNotCancelled → provider.provideDocumentSymbols(uri) → assertNotCancelled
  → documentRoutes.read() [capture #2: revision R2]
  → sameRevision(R1, R2)? no → STALE_DOCUMENT error
  → mapVscodeDocumentSymbols() → SymbolDraft[] (bounded: 5000 symbols, 64 depth)
  → handleRegistry.materialize() → IDEBPSymbol[] (sym_ handles, validUntilEpoch)
  → assertResponseFits → return { document, symbols }
```

**Symbol resolveAt flow (transient handle, revision bracket):**

```
symbol/resolveAt
  → assert utf-16 encoding → #documentSymbols() [ADR-0016 bracket: double read + compare]
  → findSymbolAtPosition(drafts, position) → innermost containing symbol
  → no symbol? → return { document } (omits symbol — ADR-0018)
  → handleRegistry.materializeTransient() → one IDEBPSymbol (own generation, not document tree)
  → return { document, symbol }
```

**Symbol lookup flow (definition/references/implementations):**

```
symbol/getDefinition | symbol/getReferences | symbol/getImplementations
  → #resolveTarget(): handle fast-path → else locator relocation (fail-closed)
  → provider.provideDefinition/References/Implementations(uri, selectionRange.start)
  → mapProviderLocations() → filter to registered roots (scope, not truncation)
  → ceiling: IDEBP_MAX_SYMBOL_LOCATIONS → truncated=true
  → return { locations, truncated }
```

**Symbol hierarchy flow:**

```
symbol/getHierarchy (relation: callers | callees | supertypes | subtypes)
  → #resolveTarget(): handle fast-path → else locator relocation (fail-closed)
  → #onIdentifier(): refine position onto declaration name (extra document-symbol query)
    — needed because prepareCallHierarchy answers nothing from column 0
  → provider.provideHierarchy(uri, refinedPosition, relation)
  → mapProviderLocations() → filter to registered roots (scope, not truncation)
  → ceiling: IDEBP_MAX_SYMBOL_LOCATIONS → truncated=true
  → return { locations, truncated }
```

**Diagnostics snapshot flow:**

```
diagnostics/getSnapshot
  → assert workspace → validate explicit URIs (out-of-root → PERMISSION_DENIED)
  → scope = all in-workspace diagnostic URIs OR explicit list
  → for each URI (cap IDEBP_MAX_DIAGNOSTIC_DOCUMENTS):
       open document? → documentRoutes.read() (exact buffer revision)
       else → documentRoutes.readFromDisk() (no editorVersion, ADR-0020)
       → mapVscodeDiagnostics() → skip unrepresentable, cap per-doc, never clip messages
       → documentUris present? → #withAvailableFixes(): per diagnostic (cap 20),
         executeCodeActionProvider → mapCodeActions → attach availableFixes
  → fitSnapshot() → drop whole documents to fit frame ceiling (never clip messages)
  → return { documents, capturedAt, truncated }
```

**Two-phase edit flows (rename, reformat, quickFix):**

```
refactor/prepareRename
  → assert trusted workspace → resolver.resolve(symbol) [handle or relocation]
  → host.prepareRename(uri, position) → null → PRECONDITION_FAILED
  → host.provideRenameEdits(uri, position, newName) → null → CAPABILITY_UNAVAILABLE
  → host.describeEdit() → bounds (500 docs, 10000 edits) → root containment check
  → collect revision precondition per affected document (open or disk read)
  → sweep expired plans → cap 32 live → store StoredPlan { plan, edit, sessionId, epoch, 2-min expiry }
  → return { plan } (with irreversibility warning)

refactor/prepare (operation: reformat)
  → assert trusted workspace → host.provideFormatEdits(uri) → undefined/null → CAPABILITY_UNAVAILABLE
  → host.describeEdit() → find change for requested URI → not found → PROVIDER_FAILED
  → revision precondition for the one document → store plan (guarantee: syntactic)
  → return { plan } (with irreversibility warning)

refactor/prepare (operation: quickFix)
  → assert trusted workspace → parse fixId + range from arguments
  → revision precondition for the one document
  → host.provideCodeActions(uri, range) → re-derive codeActionFixId(kind, title) per action
  → match against consumer's fixId → not found → PRECONDITION_FAILED (offer gone/stale)
  → host.describeEdit(edit) → find change for requested URI → store plan (guarantee: semantic)
  → return { plan } (with irreversibility warning)

workspace/applyPlan
  → assert trusted workspace → #consumePlan() (one-shot: removed before edit runs)
  → assert workspaceEpoch match → re-verify every precondition (contentHash)
  → host.applyEdit(edit) → false → PROVIDER_FAILED (all-or-nothing in VS Code)
  → for each precondition URI: host.save() → read after save → hash after save settles
  → invalidate handles for all touched URIs
  → optional: diagnosticsFor() post-apply diagnostics
  → return { modifiedDocuments: [{ document, beforeHash, afterHash }] }

workspace/discardPlan → #discardPlan() → PLAN_NOT_FOUND if unknown → { discarded: true }
```

**Event flow:**

```
VS Code document event (open/change/save/close)
  │
  ├─ onDidChangeTextDocument:
  │    ├─ documentChanged callback → symbolRoutes.invalidateDocument + editRoutes.invalidateDocument
  │    └─ debounce 75ms → #queueDocument("document/changed") → #serialize → #notifyDocument
  │
  ├─ onDidOpenTextDocument → #queueDocument("document/opened")
  ├─ onDidSaveTextDocument → flush pending change → #queueDocument("document/saved")
  ├─ onDidCloseTextDocument → flush pending change → #queueDocument("document/closed")
  │
  ├─ onDidChangeDiagnostics → debounce per-URI 75ms → #queueDiagnostics(uri)
  │    → mapOpenDocument → diagnostics/changed { workspaceId, documentUri, revision }
  │
  ├─ onDidRenameFiles → #expandFileGesture (folder → open docs beneath)
  │    → mapOpenDocument → document/renamed { workspaceId, previousUri, document }
  │    → documentRenamed callback → invalidateForUri (both URIs)
  │
  ├─ onDidDeleteFiles → #expandDeletion (folder → open docs beneath)
  │    → document/deleted { workspaceId, uri }
  │    → documentDeleted callback → invalidateForUri
  │
  ├─ onDidGrantWorkspaceTrust → workspace/trustChanged { workspaceId, adapterId, trust }
  │
  └─ onDidChangeWorkspaceFolders → #serialize → #reconcileWorkspace
       → workspace/opened | workspace/closed | workspace/rootsChanged
       → workspaceProjectionChanged callback → invalidateAll (on epoch/workspaceId change)

FileSystemWatcher (external disk changes)
  → onDidChange/onDidDelete/onDidCreate → invalidateForUri (symbols + plans)
  → no notification emitted (cannot observe rename vs delete+create — ADR-0022)
```

## Integration Points

- **Consumed by:** VS Code extension host loads `extension.ts` via `package.json` main entry.
  Bundled as CommonJS via esbuild into `dist/extension.js` (extension) and `dist/daemon-child.js`
  (auto-start daemon). All ESM IDE Bridge runtime deps are bundled; only `vscode` is external.
- **Depends on (internal):**
  - `@ide-bridge/bridge-client` — `connectReconnectingBridgeClientFromDiscoveryFile`,
    `readPrivateDiscoveryFile`, `AuthenticatedBridgeConnection`, `ReconnectingBridgeConnection`,
    `BridgeReconnectState`, `BridgeAdapterRequestError`, `MAX_CLIENT_MESSAGE_BYTES`
    (`adapter-lifecycle.ts:1-7`, `document-routes.ts:1-5`, `symbol-routes.ts:1-5`,
    `symbol-navigation-routes.ts:1-5`, `diagnostic-routes.ts:1-5`, `edit-routes.ts:1-5`,
    `symbol-target.ts:9`)
  - `@ide-bridge/protocol` — `AdapterId`, `RootId`, `WorkspaceId`, `SessionId`,
    `IDEBPEndpointTopology`, `IdeRegisterRequest`, `IdeRegisterResponse`, `Workspace`,
    `WorkspaceRoot`, `DocumentContent`, `DocumentReference`, `DocumentTargetParams`,
    `Revision`, `Range`, `Position`, `Symbol`, `SymbolHandle`, `SymbolHandleId`, `SymbolKind`,
    `SymbolLocator`, `SymbolLocation`, `SymbolReference`, `Diagnostic`, `DocumentDiagnostics`,
    `EditPlan`, `ModificationResult`, `ModifiedDocument`, `DocumentRevisionPrecondition`,
    `IDEBPNotificationMethod`, `IDEBPNotificationParams`, `JSONRPCRequestIdentifier`,
    `assertIDEBPLoopbackEndpoint`, `isUriWithinWorkspaceRoot`,
    `IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT`, `IDEBP_MAX_SYMBOL_SEARCH_LIMIT`,
    `IDEBP_MAX_SYMBOL_LOCATIONS`, `IDEBP_MAX_DIAGNOSTIC_DOCUMENTS`,
    `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT`
  - `@ide-bridge/cli` — `resolveDiscoveryFilePath` (`configuration.ts:1`), `runCli`
    (`daemon-child.ts:1`)
- **Depends on (external):** `vscode` API (the only external unbundled import), `node:crypto`,
  `node:path`, `node:child_process`.
- **External boundaries:**
  - **VS Code settings** (`ideBridge.*`): `autoStartDaemon` (bool, default true),
    `manualEndpoint` (string, validated loopback), `discoveryFile` (string, resolved via CLI),
    `logLevel` ("debug"|"error"|"info"|"warn", default "info"), `providerTimeoutMs`
    (int, 100–300000, default 30000) — `configuration.ts:30-34`
  - **Discovery file:** resolved path from `resolveDiscoveryFilePath`; must be `0600` on Unix;
    read via `readPrivateDiscoveryFile` for auth — `adapter-lifecycle.ts:175`
  - **Daemon child process:** `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, spawned with
    `dist/daemon-child.js` path from `context.asAbsolutePath` — `extension.ts:300`,
    `daemon-process.ts:23-39`
  - **Loopback only:** `assertIDEBPLoopbackEndpoint` validates manual endpoint —
    `configuration.ts:50`
  - **Capabilities declared in `capabilities.ts:11-56`** — imported by `extension.ts:15` and
    passed at registration (`extension.ts:343`). 16 entries: 13 supported + 3 unavailable:
    - Native: `document/read`, `document/getRevision`, `diagnostics/getSnapshot`,
      `workspace/applyPlan`, `workspace/discardPlan`
    - Provider/semantic: `document/getSymbols`, `workspace/searchSymbols`, `symbol/resolveAt`,
      `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations`,
      `symbol/getHierarchy`, `refactor/prepareRename` (preview, atomicity: text-only)
    - Provider/syntactic: `refactor/prepare` (serves `reformat` and `quickFix`, routed by name)
    - Unavailable: `workspace/searchTodos`, `workspace/listBookmarks`,
      `workspace/undo` (VS Code exposes no revert API — ADR-0021)
  - **5 route groups attached** — `extension.ts:309-313`:
    `documentRoutes`, `symbolRoutes`, `navigationRoutes`, `diagnosticRoutes`, `editRoutes`
  - **Notifications wired:** `document/opened`, `document/changed` (75ms debounce),
    `document/saved`, `document/closed`, `document/renamed`, `document/deleted`,
    `diagnostics/changed` (75ms debounce per-URI), `workspace/opened`, `workspace/closed`,
    `workspace/rootsChanged`, `workspace/trustChanged` — `event-bridge.ts:130-192`
  - **Response size limit:** `MAX_CLIENT_MESSAGE_BYTES` enforced on all route responses —
    `document-routes.ts:183-188`, `symbol-routes.ts:221-223`,
    `symbol-navigation-routes.ts:431-438`, `diagnostic-routes.ts:225-230`,
    `edit-routes.ts:598-605`

## Common Gotchas

1. **Capabilities are centralized in `capabilities.ts`** (`capabilities.ts:11-56`), not declared
   inline at the registration site. `ADAPTER_CAPABILITIES` is a single frozen
   `Partial<Record<IDEBPApplicationMethod, Capability>>` imported by `extension.ts:15` and passed
   directly at registration (`extension.ts:343`). 16 entries cover 13 supported methods + 3
   explicitly unavailable. A method missing from this map is not a smaller capability set, it is a
   consumer receiving no answer and no explanation — anything unimplemented is declared
   `unavailable` with a reason instead of being omitted. `refactor/prepare` is declared
   `provider`/`syntactic` and serves `reformat` and `quickFix`, which are routed by name at request
   time so a consumer learns which operation it asked for was not wired. Explicitly **unavailable**:
   `workspace/searchTodos`, `workspace/listBookmarks`, `workspace/undo` (VS Code exposes no API to
   revert an applied `WorkspaceEdit` — ADR-0021).

2. **Applying a plan saves to disk and cannot be undone here.** VS Code exposes no API to revert
   an applied `WorkspaceEdit`, and the adapter saves every modified document, so neither undo nor
   close-without-saving is available afterwards. Every prepared plan carries a warning saying so
   (`edit-routes.ts:202-204`, `edit-routes.ts:295-297`, `edit-routes.ts:428-431`). Plans are
   one-shot: removed before the edit runs so a retry
   cannot replay them (`edit-routes.ts:547-549`).

3. **`revision.editorVersion` is optional and must be checked before use.** It exists only while
   a document is open in an editor buffer; a file on disk has none, and `contentHash` is the
   authoritative identity in both cases (ADR-0020). Editor versions are compared only when both
   sides carry one.

4. **A diagnostics snapshot covers the whole workspace, but events only cover open documents.**
   Closed documents are read from disk, so they appear in the snapshot without an
   `editorVersion`. `diagnostics/changed` is driven by editor state and is therefore emitted for
   open documents only (ADR-0019) — a consumer polling the snapshot can see changes the event
   stream never announced. Code-action fix offers are attached only when the consumer names
   specific documents (`documentUris` is present); a project-wide sweep omits them to avoid
   exhausting the daemon's route timeout (`diagnostic-routes.ts:92-97`).

5. **Search handles are weaker than document handles.** A `workspace/searchSymbols` handle carries
   no verified revision (ADR-0017) — the provider ran over its own snapshots of many documents.
   Every operation consuming one re-resolves it through locator relocation and fails closed
   (ADR-0018); none acts on it directly.

6. **`symbol/resolveAt` omits `symbol` when no symbol covers the position.** A blank line or a
   comment is an ordinary query, so the result carries the document reference with no symbol and
   no handle is minted (`symbol-navigation-routes.ts:89-95`). `symbol` is optional in the schema
   for exactly this (ADR-0018).

7. **`truncated` on lookup results reports the ceiling only.** Root filtering does not set it —
   scope is not incompleteness — but a result capped at `IDEBP_MAX_SYMBOL_LOCATIONS` does, since
   these requests carry no `limit` and would otherwise read as complete (ADR-0018).

8. **An empty lookup result may mean "no provider".** VS Code's `executeReferenceProvider` and
   friends return `[]` whether or not a provider is registered, so `CAPABILITY_UNAVAILABLE` fires
   only on `undefined`/`null` (`symbol-navigation-routes.ts:134-136`). No public API distinguishes
   the two; the adapter states this rather than guessing (ADR-0018).

9. **All error codes are non-retryable.** Document routes return `CANCELLED`,
   `DOCUMENT_NOT_FOUND`, `PROVIDER_FAILED`, `WORKSPACE_NOT_FOUND` (`document-routes.ts:201-209`).
   Symbol routes return `CANCELLED`, `CAPABILITY_UNAVAILABLE`, `PROVIDER_FAILED`,
   `STALE_DOCUMENT` (`symbol-routes.ts:249-258`). Navigation routes return `CANCELLED`,
   `CAPABILITY_UNAVAILABLE`, `INVALID_REQUEST`, `PERMISSION_DENIED`, `PROVIDER_FAILED`,
   `STALE_SYMBOL`, `AMBIGUOUS_SYMBOL` (`symbol-navigation-routes.ts:452-466`). Edit routes return
   `WORKSPACE_NOT_FOUND`, `PERMISSION_DENIED`, `PRECONDITION_FAILED`, `PROVIDER_FAILED`,
   `STALE_DOCUMENT`, `PLAN_EXPIRED`, `PLAN_NOT_FOUND`, `CAPABILITY_UNAVAILABLE`,
   `DOCUMENT_NOT_FOUND`, `INVALID_REQUEST`
   (`edit-routes.ts:525-535`, `symbol-target.ts:160-178`). Diagnostics routes return `CANCELLED`,
   `PERMISSION_DENIED`, `WORKSPACE_NOT_FOUND` (`diagnostic-routes.ts:232-238`).

10. **TOCTOU protection on symbol queries (ADR-0016).** `document/getSymbols` and
    `symbol/resolveAt` perform two separate `documentRoutes.read()` calls — before and after the
    provider call — and compare `editorVersion`, `contentHash`, and `workspaceEpoch`. If any
    differ, the result is discarded with `STALE_DOCUMENT` (`symbol-routes.ts:145-152`,
    `symbol-navigation-routes.ts:299-314`, `symbol-target.ts:122-137`). The provider output is
    never trusted without a revision match.

11. **Symbol handles are opaque and session-bound.** Handle IDs are `sym_` + 144-bit
    crypto-random base64url (`symbol-mapper.ts:330`). Each handle carries `validUntilEpoch`
    bound to the workspace epoch at materialization time. Handles are invalidated per-document on
    change and globally on reconnect/epoch transitions. Capacity is 20000 by default; exceeding
    it throws during `materialize` (`symbol-mapper.ts:278-288`).

12. **Two handle namespaces: document vs transient.** `materialize` replaces a document's tree
    atomically via stage-then-commit. `materializeTransient` puts individual results (search hits,
    point resolutions) in bounded FIFO generations (max 5), evicted oldest-first. Producing a
    transient handle never revokes handles a document already handed out
    (`symbol-mapper.ts:211-248`). Capacity reservation evicts transient generations before
    document handles (`symbol-mapper.ts:278-288`).

13. **Document change invalidates symbols and plans immediately, before debounce.** The
    `documentChanged` callback fires synchronously from `onDidChangeTextDocument`, calling
    `symbolRoutes.invalidateDocument` and `editRoutes.invalidateDocument` before the 75ms debounce
    timer starts (`extension.ts:250-256`, `event-bridge.ts:134-136`). This ensures stale handles
    and plans are cleared before any `document/changed` notification reaches the daemon.

14. **Workspace projection change invalidates all symbols and plans.** When the event bridge
    detects a workspace ID or epoch change, `workspaceProjectionChanged` calls
    `symbolRoutes.invalidateAll()` and `editRoutes.invalidateAll()` (`extension.ts:265-274`).
    This fires before `projectedWorkspace` is updated.

15. **Reconnect invalidates all semantic state.** On `"reconnect"` reason, both
    `workspaceModel.invalidateSemanticState()` (epoch++) and `symbolRoutes.invalidateAll()`
    (handle clear) are called before rebuilding registration params (`extension.ts:325-328`).
    The `configureConnection` disposer also calls `invalidateAll` on both routes
    (`extension.ts:315-316`).

16. **Event notifications are serialized.** `VscodeEventBridge.#serialize` chains all
    notifications through a single promise tail (`event-bridge.ts:411-415`). Notifications are
    delivered in order but never concurrently. Errors in one notification do not break the chain.

17. **Debounce has overflow protection.** When `#pendingChanges` reaches 1024 entries and a new
    document change arrives, the change is sent immediately without debouncing rather than
    dropped (`event-bridge.ts:318-319`). Save and close events always flush pending debounced
    changes first (`event-bridge.ts:138-145`).

18. **Synchronization yields to the extension host.** During initial `synchronize`, every 16th
    document triggers a `setImmediate` yield to avoid blocking the extension host
    (`event-bridge.ts:111`).

19. **URI round-trip is verified twice.** `documentRoutes.read` verifies `uri.toString() ===
params.uri` both before `openTextDocument` (synchronous parse) and after (async result)
    (`document-routes.ts:78`, `document-routes.ts:97`). This catches cases where VS Code
    normalizes or reinterprets the URI during async open.

20. **Auto-start is local-Unix only.** `#assertAutoStartAllowed`
    (`adapter-lifecycle.ts:161-181`) rejects auto-start on win32, on non-local topology
    (remote/web/ssh/wsl/dev-container/codespace), and when `endpointOverride` is set. It also
    rejects if the discovery file exists but is invalid (only `ENOENT` is tolerated).

21. **Adapter ID is immutable for a lifecycle.** `#register` (`adapter-lifecycle.ts:188-190`)
    throws if `params.adapterId` differs from the first registration's ID. The registration
    provider must return the same `adapterId` on every call.

22. **Epoch only bumps on real change after init.** `#synchronizeRoots`
    (`workspace-model.ts:107`) increments `#workspaceEpoch` only when roots actually change
    _and_ the model has been initialized. The first snapshot does not bump the epoch.
    `invalidateSemanticState()` is the explicit bump path for reconnects.

23. **Duplicate root URIs are rejected.** `#synchronizeRoots` (`workspace-model.ts:94-96`)
    throws if `activeUris` contains duplicates. VS Code normally prevents this, but the model
    enforces it.

24. **Out-of-root documents are rejected.** `relativeUriPath` (`document-mapper.ts:176-184`)
    throws if scheme, authority differ, or if the relative path escapes the root (`..` or
    starts with `../`). Empty relative paths are also rejected.

25. **Registration is never cached.** On reconnect, `restoreSession`
    (`adapter-lifecycle.ts:151-156`) calls `#register` with `"reconnect"` reason, and the
    registration provider rebuilds params from _current_ VS Code state
    (`extension.ts:324-341`). Stale snapshots are never reused.

26. **stop() is idempotent and memoized.** `#stopTask` (`adapter-lifecycle.ts:80`) ensures
    cleanup runs once. `#stopping` flag causes in-flight `start()` to abort cleanly
    (`adapter-lifecycle.ts:87-90`).

27. **Daemon stop is best-effort SIGTERM → SIGKILL.** `stopOwnedProcess`
    (`daemon-process.ts:66-85`) sends SIGTERM, waits 3s (`GRACEFUL_STOP_TIMEOUT_MS`), then
    SIGKILL if still alive. `stop()` on an already-exited process is a no-op.

28. **Only `vscode` is external in the bundle.** All `@ide-bridge/*` packages and Node builtins
    are bundled by esbuild. A change to `@ide-bridge/bridge-client` or `@ide-bridge/cli` public
    API requires a rebuild before the extension picks it up.

29. **Untrusted workspaces are supported read-only.** `workspaceModel.snapshot` maps
    `vscode.workspace.isTrusted` to `"trusted"` or `"untrusted"` (`workspace-model.ts:69`).
    Writes are disabled in untrusted mode (`edit-routes.ts:593`) but connection/registration
    proceed. Trust must not be silently disabled (AGENTS.md §4).

30. **Trust is checked at both prepare and apply phases.** A workspace can lose trust between
    preparing and applying, and a plan is not an authorization to write later
    (`edit-routes.ts:582-595`).

31. **Relocation matches semantic fields, not the fingerprint.** `relocateSymbol`
    (`symbol-relocation.ts:29-54`) matches on name + kind + optional `containerName`, using the
    selection range only to break ties. The fingerprint encodes position and would fail for any
    symbol shifted by a single line — precisely when a handle goes stale (ADR-0018 amends
    ADR-0003).

32. **Relocation fails closed.** Zero matches → `STALE_SYMBOL`; several indistinguishable
    matches → `AMBIGUOUS_SYMBOL` with up to 32 candidates (`symbol-relocation.ts:27,49-53`).
    Relocation never guesses.

33. **`containerName` is optional in relocation.** A locator minted from a flat search result may
    legitimately lack the container that the hierarchical document provider reports, so an absent
    container on either side is treated as "unspecified" rather than as a mismatch
    (`symbol-relocation.ts:73-78`).

34. **Diagnostic messages are never clipped.** Payload size in diagnostics responses is
    controlled by dropping whole documents via `fitSnapshot` (`diagnostic-routes.ts:150-163`).
    Altering the text of a diagnostic would silently misreport what the language service said.

35. **Diagnostic mapping skips rather than fails.** One malformed diagnostic from one extension
    must not hide every other diagnostic in the workspace. Skipping sets `truncated`
    (`diagnostic-mapper.ts:37-57`). Related information outside the workspace is dropped
    (`diagnostic-mapper.ts:88-105`).

36. **VS Code may register at most one workspace.** `cloneSingleWorkspace`
    (`event-bridge.ts:418-421`) throws if `registeredWorkspaces.length > 1`. The event bridge
    tracks a single `#announcedWorkspace` and reconciles transitions to/from undefined.

37. **Workspace identity is fixed for a lifecycle.** `#reconcileWorkspace`
    (`event-bridge.ts:362-402`) throws if `workspaceId` or `adapterId` changes between the
    announced and current workspace. Only root composition and epoch may change.

38. **File rename/delete gestures are expanded to open documents only.** A folder rename fires
    one VS Code event for the folder; the bridge projects it onto the open documents beneath it,
    the only children identifiable truthfully (`event-bridge.ts:278-293`). Files renamed outside
    the editor produce no event and so produce none here (ADR-0022).

39. **External disk changes invalidate but do not notify.** The `createFileSystemWatcher`
    invalidates symbol handles and plans for externally changed URIs but emits no notification:
    a watcher cannot tell a rename from a delete-plus-create (`extension.ts:291-300`).

40. **`symbol/getHierarchy` refines search-handle positions.** VS Code's
    `prepareCallHierarchy` answers nothing from column 0 — the position a search handle carries
    — so `#onIdentifier` (`symbol-navigation-routes.ts:168-182`) runs an extra document-symbol
    query to move the position onto the declaration's name. The lookups do not need this
    refinement, so the cost is spent only where it changes the answer.

41. **Quick-fix offers are re-derived, not remembered.** A `fixId` published in a diagnostics
    snapshot is never stored by the adapter. At prepare time, `#prepareQuickFix`
    (`edit-routes.ts:226-309`) re-queries `vscode.executeCodeActionProvider` and re-derives the
    FNV-1a identifier from `kind + title` to find the matching action. If the document changed
    or the offer is gone, nothing matches and the request is refused (`PRECONDITION_FAILED`)
    rather than applying a different fix that happens to sit in the same slot.

42. **`refactor/prepare` serves reformat and quickFix only.** Other operations
    (`optimizeImports`, structural refactorings) are refused **by name** at request time with
    `CAPABILITY_UNAVAILABLE` rather than being hidden behind an unavailable capability. A
    consumer that asks gets a code it can act on instead of silence
    (`edit-routes.ts:152-155`).
