# Phase 3 VS Code foundation audit — 2026-08-02

## Verdict

**ACCEPT for the bounded foundation increment.** The package is now shaped as a loadable VS Code
desktop workspace extension, and the first IDE-to-IDEBP mapping boundary covers multi-root
workspaces, trust, opaque identities, epochs, remote URI preservation, and in-memory revisions.

This is not acceptance of Phase 3 as a whole. Activation still acquires no connection, no adapter is
registered, no routed method handler or event bridge exists, no provider capability is announced,
and neither a self-contained VSIX nor a real extension-host launch has been validated.

## Boundary audited before implementation

- Phase 3 scope and acceptance criteria in `TASK.md` and the implementation plan;
- official VS Code manifest, activation, extension-host, and workspace-trust requirements;
- all thirteen daemon-routed IDEBP methods;
- ADR-0002 revision semantics, ADR-0005 capability dimensions, ADR-0006 ownership/routing, and
  ADR-0008 inbound handler behavior;
- existing shared-client typed handler and reconnection APIs;
- Phase 0 manifest, compiler module output, no-op activation, and test discovery;
- workspace/root identity, multi-root topology, trust, URI, and unsaved-buffer boundaries.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| VSC-F01 | Critical | TypeScript emitted CommonJS while the package declared ESM, and the manifest had no `main` or activation event. A successful `tsc` was not evidence of a loadable extension. | Declared an explicit CommonJS desktop entry, `main`, `onStartupFinished`, workspace extension kind, and a build-time manifest/entry check. |
| VSC-F02 | High | The scoped pnpm package name could not serve as the VS Code extension name component. | Switched to unscoped `vscode-extension`, retained publisher `ide-bridge`, and updated canonical filter commands. |
| VSC-F03 | High | The skeleton had no defined mapping for simple versus multi-root windows or empty windows. | ADR-0013 maps one window to one IDEBP workspace, folders to roots, and empty windows to no workspace. |
| VSC-F04 | High | No revision implementation guaranteed that unsaved buffers, CRLF, or non-BMP text affected the hash. | Added UTF-8 SHA-256 over exact `TextDocument.getText()` content with native editor version and workspace epoch. |
| VSC-F05 | High | A document mapper accepting an arbitrary root could cross the workspace boundary. | Mapping now requires root ownership, matching canonical root URI, and URI-segment containment; it never falls back to `fsPath`. |
| VSC-F06 | Medium | Root identities and semantic invalidation behavior were unspecified. | Added cryptographic opaque IDs, stable live root IDs, replacement after removal/re-add, structural epoch increments, and explicit semantic invalidation. |
| VSC-F07 | Medium | Trust and required settings were absent from the extension manifest. | Declared limited untrusted support and settings for auto-start, authenticated endpoint override, private discovery path, log level, and bounded provider timeout; no token or public-listen setting exists. |
| VSC-F08 | High | Moving the package Vitest config to `.mts` to respect its CommonJS boundary silently removed the VS Code project from the root `*.ts` project glob. | Root Vitest now includes both `.ts` and `.mts` package configs; the complete suite rose from the misleading 29/188 result to 32/200. |
| VSC-F09 | Medium | The new CommonJS build checker and `.mts` config were outside typed ESLint project discovery. | Added narrow non-typechecked ESLint overrides for config `.mts` and CommonJS utility scripts while retaining recommended JavaScript linting. |

## Verification

Focused tests cover:

- one-window/multi-root mapping, empty windows, trust changes, stable root identity, root replacement,
  duplicate roots, structural epochs, and explicit invalidation;
- canonical registration-schema acceptance of mapped workspaces;
- exact remote URI preservation, URI-relative logical paths, UTF-16 position encoding, CRLF and
  non-BMP buffer hashing, dirty state, revision changes, invalid versions, foreign roots, and
  out-of-root documents;
- canonical `document/read` response-schema acceptance;
- extension constant export and manifest/compiled-entry build consistency.

## Validation results

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install across seven workspace projects: pass after rerunning outside the DNS-restricted
  sandbox; lockfile unchanged and no packages downloaded;
- Prettier format check and ESLint: pass;
- strict TypeScript typecheck across six packages plus scripts: pass;
- all six TypeScript package builds, including the extension manifest/entry check: pass;
- VS Code package: 3 files / 12 tests;
- complete Vitest suite: 32 files / 200 tests, including real loopback integrations;
- root CLI binary smoke: pass;
- protocol runtime catalogue and fixtures: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture typecheck, Java source fixture compilation, and PHP fixture lint:
  pass.

The first sandboxed complete-test attempt failed because local `127.0.0.1` binds returned `EPERM`.
The same locked Node 24 command passed outside that socket restriction. The Java fixture evidence is
source compilation only; its JUnit test source intentionally requires dependencies not provided by
the standalone fixture.

## Next audit boundary

Before implementing authenticated activation, audit configuration resolution, daemon auto-start
ownership, extension-host lifecycle races, shared-client reconnect restoration, current-state
registration, cleanup/unregister behavior, and logging/error exposure. No provider handler should be
added until that lifecycle owns exactly one live adapter session.
