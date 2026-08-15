# ADR-0013 — VS Code extension foundation

## Status

Accepted — 2026-08-02

## Context

The Phase 0 VS Code package compiled TypeScript but was not a valid desktop extension boundary. Its
compiler emitted CommonJS while the nearest package declared ESM, and the manifest had no
extension entry point or activation event. Phase 3 also needs one consistent mapping for VS Code
multi-root workspaces, remote URIs, trust, and in-memory document revisions before any routed
handler can be registered.

These choices affect compatibility and the security boundary. A handler must not announce support
until it can map a request to the correct workspace root and revision without converting a URI to a
local path.

## Decision

### Desktop extension module boundary

- The extension is a Node desktop extension with `extensionKind: ["workspace"]`.
- Its manifest uses the unscoped extension name `vscode-extension`, publisher `ide-bridge`, and the
  resulting stable extension identifier `ide-bridge.vscode-extension`.
- TypeScript emits CommonJS and the package explicitly declares `type: "commonjs"`.
- `main` points to `dist/extension.js`; `onStartupFinished` activates the adapter without blocking
  initial editor startup.
- The build verifies that the manifest and compiled entry point agree. A self-contained VSIX and
  real extension-host launch remain Phase 3 acceptance work, not evidence from a plain `tsc` run.

### Workspace topology and identity

- One VS Code window maps to one IDEBP workspace containing all current workspace folders as roots.
- An empty window advertises no IDEBP workspace.
- Adapter, workspace, and root identifiers are opaque random identifiers. They remain stable for
  the logical adapter lifetime; a removed and later re-added root receives a new root identifier.
- Root addition, removal, or order change increments `workspaceEpoch`. Reconnection and other
  semantic invalidations increment the same epoch explicitly.
- Root URIs use `Uri.toString()` and are never converted through `fsPath`. Document routing must use
  VS Code's workspace-folder resolution before mapping.

### Trust and capabilities

- The manifest declares limited untrusted-workspace support.
- `workspace.isTrusted` maps to IDEBP `trusted` or `untrusted` state.
- Safe read handlers may remain available in Restricted Mode, but write handlers must reject with
  `PERMISSION_DENIED` and their capabilities must become unavailable.
- No provider-backed capability is announced until its real handler and provider-presence check
  exist. There is no semantic-to-text fallback.

### Document revisions

- `TextDocument.getText()` is the revision source, including unsaved edits.
- `TextDocument.version` maps to `editorVersion`.
- `contentHash` is SHA-256 over the exact in-memory string encoded as UTF-8.
- The mapper preserves the canonical URI string, reports UTF-16 positions, and derives only an
  informative URI-relative logical path.
- Mapping rejects a document outside the selected root instead of falling back to filesystem paths.

### Configuration security

- The extension exposes auto-start, discovery file, manual endpoint, log level, and bounded provider
  timeout settings.
- A manual endpoint never supplies authentication by itself: the token still comes from a private,
  validated discovery file.
- No token setting and no public-listen setting exist. Connection code must reject non-loopback
  endpoints where the selected topology requires loopback.

## Consequences

- Development builds now have a loadable VS Code entry-point shape rather than merely compiling.
- Multi-root and remote URI behavior is defined before request handlers depend on it.
- Unsaved-buffer revisions follow ADR-0002 without reading from disk.
- Activation, daemon launch/discovery, registration, event wiring, provider handlers, VSIX packaging,
  and the real extension-host test remain explicit subsequent Phase 3 increments.

## Alternatives considered

### Keep the scoped pnpm package name as the extension name

Rejected because VS Code extension identity is formed from `publisher.name`; an npm-style scope is
not the extension name component.

### Advertise one IDEBP workspace per folder

Rejected because it loses VS Code's window-level multi-root topology and makes cross-root provider
operations ambiguous.

### Hash the file on disk

Rejected because it ignores unsaved buffers and contradicts ADR-0002.

### Activate with `*`

Rejected because `onStartupFinished` is sufficient and avoids forcing work into initial startup.
