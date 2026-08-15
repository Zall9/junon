# ADR-0014 — VS Code authenticated adapter lifecycle

## Status

Accepted — 2026-08-02

## Context

The VS Code extension must discover or start the daemon, authenticate as an adapter, register the
current workspace topology, restore registration after daemon rotation, and unregister cleanly.
This crosses the process, private-discovery, transport, session-ownership, extension-host, and log
boundaries.

The Phase 3 foundation emitted CommonJS, while the shared protocol, client, daemon, and CLI packages
are ESM-only. A direct runtime import would therefore fail even though typecheck passed. Initial
connection also differs from post-connection recovery: ADR-0009 deliberately requires the first
physical connection to succeed before returning its reconnecting facade, and a socket can still be
lost while the adapter sends its first `ide/register`.

## Decision

### Self-contained desktop bundle

- esbuild produces CommonJS bundles targeting Node 24 for `extension.js` and `daemon-child.js`.
- All IDE Bridge ESM dependencies are bundled. Only the extension-host-provided `vscode` module is
  external.
- The build removes only the package's validated `dist` directory, emits declarations, bundles both
  entries, rejects residual external `@ide-bridge/*` imports, and executes the child bundle's help
  path.
- esbuild is pinned exactly because its pre-1.0 minor releases may be breaking.

### Configuration and authenticated endpoint override

- Discovery path resolution reuses the CLI's explicit/environment/default implementation; the
  extension does not duplicate this policy.
- Provider timeout and log level are runtime-validated against their manifest bounds.
- A manual endpoint must pass the canonical loopback `/rpc` validator.
- The shared client accepts `endpointOverride` only on discovery-file connection APIs. It replaces
  only the endpoint after private-file validation; token, protocol, PID, and start metadata still
  come from the private file. Every reconnect rereads the file and reapplies the validated override.
- Manual endpoint mode disables daemon auto-start because a newly generated token cannot be assumed
  to authenticate an independently selected endpoint.

### Auto-start and process ownership

- Initial connection is attempted before any process is started.
- Auto-start is local Unix only in this increment. Windows remains blocked by the Phase 2 ACL gap;
  remote extension-host daemon topology remains deferred rather than being labelled local.
- An absent discovery file permits auto-start. An existing discovery file must already pass all
  private-file checks; invalid existing state is never overwritten or repaired silently.
- The extension spawns its bundled CLI daemon child without a shell, passes an explicit discovery
  path, drains bounded redacted output, and retains the exact child handle.
- CLI sibling-lock ownership resolves races between VS Code windows. A losing child may exit while
  the extension retries authenticated connection to the winning daemon.
- Deactivation sends `SIGTERM` only to the exact owned child, waits three seconds, and may then send
  `SIGKILL` to that same child. It never searches for or kills a PID read from discovery metadata.

### Adapter registration and reconnection

- One logical lifecycle owns one cryptographically random adapter ID and one workspace model.
- Initial registration advertises UTF-16, current VS Code version, current roots/trust, and an empty
  capability map. No routed capability is advertised before its handler exists.
- Registration responses are correlated with the requested adapter and workspace identities in
  addition to schema validation.
- Reconnection uses ADR-0009's restoration callback after logical handlers are attached and before
  the connection is republished. It rebuilds registration from current VS Code state and advances
  `workspaceEpoch`; it never replays a cached request.
- If the initial registration loses its physical socket, activation waits for one bounded restored
  connection instead of replaying the uncertain request on the old session.
- Requests made during reconnection remain unqueued and fail according to the shared client.

### Deactivation and observability

- `deactivate()` is asynchronous and explicitly awaits `ide/unregister`, connection close, and
  owned-child shutdown. It does not rely on asynchronous VS Code disposables, which are not awaited.
- Unregister is attempted only on a connected session and is bounded to five seconds. Transport
  close remains the authoritative cleanup fallback.
- Extension logs use a closed lifecycle-event vocabulary and configured severity threshold. They
  contain no paths, endpoints, tokens, workspace names, URIs, source, or raw exception messages.

## Consequences

- The extension can establish a real authenticated adapter session and survive daemon token/port
  rotation without duplicating JSON-RPC or retry machinery.
- Multiple local VS Code windows converge on CLI ownership rather than racing discovery publication.
- Manual tunnelling can retain a stable local endpoint while authentication rotates in the private
  discovery file.
- Folder/trust/document event propagation and all thirteen routed handlers remain subsequent Phase 3
  increments.
- Real VS Code extension-host launch, self-contained VSIX inspection, Windows ACL support, and remote
  daemon auto-start remain explicit validation gaps.

## Alternatives considered

### Require ESM dependencies directly from the CommonJS extension

Rejected because the shared packages expose ESM import entries only and the extension host would
fail at runtime.

### Store a token in VS Code settings for manual endpoints

Rejected because workspace or user settings are not the private discovery trust boundary and can be
synced or disclosed.

### Spawn `ide-bridge` through a shell or PATH lookup

Rejected because command resolution is mutable and shell execution is outside the allowed security
surface.

### Overwrite malformed discovery state during auto-start

Rejected because this would silently repair or replace security state whose ownership is not proven.

### Cache and replay the initial registration

Rejected by ADR-0009 because workspace roots, trust, capabilities, and epochs may have changed.
