# ADR-0015 — VS Code document reads and bounded event projection

## Status

Accepted — 2026-08-02

## Context

The first VS Code routed handlers must read the editor's current in-memory document without turning
an IDEBP URI into a filesystem path or advertising a capability before its handler exists. Document
responses and notifications also cross the daemon's workspace boundary. Schema validation alone
does not prove that the returned URI, root, workspace, or epoch belongs to the routed request.

VS Code emits a change event for every buffer mutation. Hashing and forwarding every intermediate
state would add extension-host work and event volume without improving the MVP guarantee, which
only requires a change notification to invalidate affected plans and handles. Registration and
reconnection introduce a second ordering problem: handlers must exist before capabilities become
visible, while document and folder events must not be sent before the workspace is registered.

The canonical notification catalogue has no `workspace/trustChanged` message. Reusing
`workspace/closed`/`workspace/opened` would falsely describe the IDE state, and adding a strict new
notification under protocol 0.1.0 would require an explicit compatibility/version decision.

## Decision

### Handler publication and document resolution

- The logical reconnecting client attaches `document/read` and `document/getRevision` handlers
  before `ide/register` advertises either capability.
- Both capabilities use `support: "native"` with no semantic guarantee. They report editor state;
  they do not claim semantic analysis.
- A request must name the one current IDEBP workspace. The adapter parses the URI strictly, requires
  exact serialization, resolves the owning root with VS Code `getWorkspaceFolder`, and verifies the
  root against the stable workspace model.
- `workspace.openTextDocument` is the only read path. The adapter does not use `fsPath`, Node
  filesystem APIs, or an on-disk fallback. Open dirty buffers therefore remain authoritative.
- The mapper captures URI, version, dirty state, language, text, root, and workspace epoch as one
  logical snapshot, then computes SHA-256 asynchronously over that captured UTF-8 text.
- Cancellation is checked before opening, after opening, and after hashing. Expected failures become
  canonical `WORKSPACE_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, or `CANCELLED` adapter errors; unexpected
  failures become payload-free `PROVIDER_FAILED`.
- Before returning, the adapter verifies that the complete JSON response fits the shared 10 MiB
  WebSocket message ceiling. There is no truncation because truncated source would violate the
  document contract.

### Daemon validation

- Routed `document/read`, `document/getRevision`, and `document/getSymbols` successes must return the
  exact requested URI.
- Their document reference must name the routed workspace, a registered root, the current workspace
  epoch, and a URI contained by that root using the daemon's URI-only containment check.
- Document opened/changed/saved/closed/deleted notifications receive the same workspace, root,
  epoch, and containment checks before broadcast. Rename notifications validate both the previous
  URI and the new document reference.
- An invalid routed result becomes `PROVIDER_FAILED` for the consumer and closes the offending
  adapter session. An invalid notification closes the adapter before broadcast.

### Event ordering and restoration

- Document listeners start only after the first successful registration. Existing open documents
  are then projected as `document/opened` notifications.
- Change notifications are coalesced per URI for 75 ms, with at most 1,024 pending debounce timers.
  Save and close flush a pending change first. All emitted document and workspace notifications are
  serialized so their send order is deterministic.
- Reconnection does not replay cached notifications. After the new current-state registration, the
  adapter projects the currently open documents again and reconciles the registered roots against
  current VS Code state using the candidate authenticated connection.
- A non-empty root change emits `workspace/rootsChanged` with the advanced epoch. Empty-to-non-empty
  emits `workspace/opened`; non-empty-to-empty emits `workspace/closed`, matching the actual window
  state and the schema's non-empty root invariant.
- Routed document mapping uses the last workspace projection written to the daemon, not a newer VS
  Code folder snapshot. The projection advances only after the root notification write completes;
  later responses share the adapter socket's ordering behind that notification.
- Notification failures from live VS Code callbacks are contained. Reconnection registration is the
  authoritative state restoration boundary.

### Explicitly deferred events

- Dynamic workspace trust propagation remains unavailable until the protocol defines a truthful
  notification and compatibility/version decision. No synthetic close/open is sent.
- `document/renamed` and `document/deleted` remain deferred until the adapter has a bounded reference
  cache or a pre-delete capture strategy that can always provide the canonical revision-bearing
  document reference.
- Semantic/provider routes and their capabilities remain unavailable.

## Consequences

- Consumers can read exact unsaved VS Code content and revisions through the real authenticated
  daemon route.
- The daemon no longer trusts a schema-valid adapter document reference to establish workspace
  containment or exact target correlation.
- Change storms produce the latest revision event rather than hashing every intermediate edit.
- Trust, rename, and delete gaps remain visible instead of being represented by approximate events.

## Alternatives considered

### Read from the filesystem when a document is closed

Rejected because it bypasses VS Code filesystem providers, breaks remote URI schemes, and creates a
different authority from open unsaved buffers.

### Advertise capabilities and attach handlers afterward

Rejected because a consumer could route into the publication window and receive a contradictory
`CAPABILITY_UNAVAILABLE` response.

### Emit every text change immediately

Rejected because notifications carry revisions rather than text deltas; coalescing preserves the
required invalidation signal with less extension-host and transport work.

### Model trust changes as workspace close/open

Rejected because the workspace did not close and the protocol forbids hiding unsupported behavior
behind an approximate implementation.
