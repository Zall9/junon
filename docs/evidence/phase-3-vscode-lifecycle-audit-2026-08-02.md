# Phase 3 VS Code authenticated lifecycle audit — 2026-08-02

## Verdict

**ACCEPT for the bounded authenticated-lifecycle increment on local Unix hosts.** The extension now
builds autonomous CommonJS entries, resolves and validates configuration, authenticates from private
discovery state, optionally starts an exactly owned bundled CLI daemon, registers current VS Code
workspace state, restores it after daemon rotation, and awaits unregister/shutdown.

Phase 3 remains **In progress**. No routed provider handler or VS Code event bridge exists yet, the
capability map is deliberately empty, and real extension-host/VSIX evidence remains pending. Windows
and remote-host daemon auto-start are explicitly unavailable rather than approximated.

## Boundary audited before implementation

- CommonJS extension loading against ESM-only IDE Bridge packages;
- official activation/deactivation and asynchronous disposable behavior;
- configuration source, discovery-path precedence, endpoint override, and token storage;
- local auto-start authority, malformed discovery state, multi-window races, and child ownership;
- first registration versus transport-loss races;
- ADR-0006 adapter/workspace ownership, ADR-0008 inbound bounds, and ADR-0009 reconnect restoration;
- current versus cached roots, trust, capabilities, and epochs;
- unregister ordering, child termination, and log/error exposure;
- local, remote-workspace, web, and URI-scheme topology announcement.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| VSC-L01 | Critical | The CommonJS entry would `require()` ESM-only shared packages as soon as lifecycle imports became real. The no-op skeleton hid this runtime failure. | Pinned esbuild 0.28.1 and bundle all IDE Bridge runtime code into CommonJS Node 24 extension/child entries; only `vscode` is external. |
| VSC-L02 | High | Existing reconnect APIs could not honor the required manual endpoint setting without bypassing private discovery or losing token rotation. | Added a typed `endpointOverride` to discovery-file APIs; only the endpoint is replaced, complete metadata is revalidated, and every reconnect rereads the token-bearing private file. |
| VSC-L03 | Critical | Blind auto-start could overwrite malformed/insecure discovery state or try to mint a token for an unrelated manual endpoint. | Auto-start requires absent or already valid discovery, is disabled with manual endpoints, and never repairs invalid state. |
| VSC-L04 | High | PATH/shell spawning would create command-injection and mutable-resolution risk. Killing a PID from discovery could target a reused or foreign process. | The extension spawns its bundled child directly with no shell, retains the exact child handle, and signals only that child. CLI sibling ownership still resolves window races. |
| VSC-L05 | High | A socket can close between creation of the reconnect facade and the first `ide/register`, leaving activation uncertain. | Initial registration failure waits only for one bounded restored connection when the physical connection is actually lost; ordinary registration errors still fail. |
| VSC-L06 | High | Caching the first registration would restore stale roots, trust, capabilities, or epoch. | The ADR-0009 callback rebuilds from current VS Code state and increments `workspaceEpoch` before the candidate becomes connected. |
| VSC-L07 | High | Schema-valid registration responses were not correlated with caller-supplied adapter/workspace identities. | Added adapter ID, workspace count, owner, and workspace-ID correlation after typed response validation. |
| VSC-L08 | Medium | VS Code does not await asynchronous cleanup placed only in `context.subscriptions`. | Exported asynchronous `deactivate()` explicitly awaits unregister, reconnecting-client close, and owned-child shutdown. |
| VSC-L09 | Medium | Raw child output, paths, endpoints, or caught errors could leak through extension logs. | Child streams are drained without forwarding; extension logs accept only six closed payload-free lifecycle event names with severity filtering. |
| VSC-L10 | High | Spawning the current local-topology daemon in a remote extension host would misrepresent the daemon side of the handshake. | Remote state is announced by the adapter, but remote auto-start fails closed until daemon topology is configurable. Existing remote daemons may still be connected through validated discovery. |

## Verification

Focused coverage includes:

- configuration defaults, relative path resolution, bounded timeouts/log levels, and loopback-only
  endpoint overrides;
- local/SSH host kind, environment kind, and actual URI schemes;
- closed logging vocabulary and threshold filtering;
- exact child spawning, idempotent graceful stop, and invalid child path rejection;
- real daemon registration, daemon-observed workspace state, awaited unregister, and empty capability
  announcement;
- real daemon/token/port rotation with current-state re-registration and epoch advance;
- guarded auto-start with absent discovery and refusal for malformed discovery, manual endpoint, and
  remote extension host;
- shared-client endpoint override success using private-file authentication and pre-send rejection of
  a non-loopback override;
- build-time autonomous bundle inspection and executable child help smoke.

## Validation results

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install across seven workspace projects: pass; pnpm intentionally reports esbuild's install
  script as ignored, while its locked platform package exposes esbuild 0.28.1 and the build succeeds;
- Prettier format check and ESLint: pass;
- strict TypeScript typecheck across six packages plus scripts: pass;
- all six TypeScript package builds: pass;
- autonomous bundle sizes before source maps: extension 585.1 KiB, daemon child 653.3 KiB;
- bundled child load/help smoke and absence of external `@ide-bridge/*` requires: pass;
- VS Code package: 6 files / 23 tests;
- bridge-client: 7 files / 44 tests;
- complete Vitest suite: 35 files / 213 tests, including real loopback integrations;
- root CLI binary smoke: pass;
- protocol runtime catalogue and fixtures: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture typecheck, Java source fixture compilation, and PHP fixture lint:
  pass.

## Remaining limitations

- Windows private discovery/ownership ACL support remains the formal Phase 2 blocker.
- Remote extension-host daemon auto-start requires a configurable and truthful daemon handshake
  topology.
- Workspace folder/trust/document events are not yet sent to the daemon.
- All thirteen routed methods remain unimplemented and unavailable.
- A real VS Code extension-host launch and VSIX content inspection remain Phase 3 acceptance work.

## Next audit boundary

Before adding document routes and events, audit workspace ownership changes, `getWorkspaceFolder`
selection, open versus closed document reads, filesystem-provider access, unsaved buffers, change
event coalescing/order, revision invalidation, notification failure during reconnect, cancellation,
and safe error normalization. Implement only `document/read` and `document/getRevision` first; keep
semantic/provider capabilities unavailable.
