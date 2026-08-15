# ADR-0023 — VSIX packaging, inspection, and real extension-host validation

## Status

Accepted — 2026-08-02

## Context

Every VS Code adapter increment so far was verified against a simulated host: hand-written objects
standing in for `TextDocument`, provider commands, and workspace state. That is enough to pin down
the adapter's own logic, and it is exactly the wrong tool for the two questions that remained.

The first is what actually ships. `vsce package` includes everything not excluded, and by default
that meant TypeScript sources, tests, build scripts, TypeScript configuration, incremental build
state, and source maps whose `sourcesContent` embeds the complete original sources — roughly twice
the payload, none of it usable by a user.

The second is whether the adapter is right about VS Code. Every claim about provider behaviour,
symbol kinds, ranges, and multi-file rename was an inference from documentation. The Phase 1
language expectation fixtures were written the same way, so a mistaken assumption could be
consistent across both and still be wrong.

## Decision

### The packaged artifact is inspected, not trusted

- A `.vscodeignore` declares what is excluded; `scripts/check-vsix.cjs` verifies the archive that
  results. It asserts the required entries are present, that no forbidden category appears
  (sources, tests, scripts, `node_modules`, source maps, TypeScript configuration, build state,
  internal documentation), that the size stays under a ceiling, and that the manifest still declares
  the entry point, an activation event, and limited untrusted-workspace support.
- Inspection is part of `pnpm --filter vscode-extension package`, so an artifact that drifts fails
  the command rather than being published.
- The check runs against the archive, because the guarantee that matters is what a user's VS Code
  receives, not what the ignore file intended.

### One end-to-end suite, in a real extension host

- `pnpm --filter vscode-extension test:integration` downloads a real VS Code, opens the
  deterministic TypeScript fixture project, activates the extension, lets it auto-start a daemon,
  and drives the protocol from a separate consumer client.
- The scenario is derived from `packages/protocol/fixtures/languages/typescript.expected.json`
  rather than from expectations restated in the test. It therefore verifies the contract Phase 1
  declared instead of re-asserting what the implementation happens to do.
- The rename writes to fixture files. The launcher snapshots them before the run and restores them
  after, in a `finally`: the fixture is a committed contract, not scratch space.
- The suite is bundled with esbuild exactly like the extension, because the extension host cannot
  resolve workspace packages. Vitest is configured to ignore `test/integration`, which it cannot
  load.

### Two environment-specific facts worth recording

- `@vscode/test-electron` 2.5.2 derives the macOS binary as `Contents/MacOS/Electron`; current
  stable builds ship `Contents/MacOS/Code`. The download is correct, so the launcher reuses it and
  only corrects the executable path when the expected one is absent.
- The run needs a GUI session. It is not headless-capable on macOS and will not run on a bare CI
  runner without a display.

## What the real host contradicted

The Phase 1 TypeScript expectation declared the Unicode constant `π` as `kind: "constant"`. The
real TypeScript document-symbol provider reports `export const π = Math.PI` as
`SymbolKind.Variable`, and VS Code offers no other signal. The adapter maps the numeric enum
exactly, so the honest correction is to the expectation, not to the mapping: deriving `constant`
from source text would be a syntactic guess presented as semantic, which AGENTS.md §1 forbids. The
fixture now records `variable` together with the reason and the date it was verified.

This is the whole value of the increment: an assumption that had been consistent across the
protocol fixtures and the adapter for two phases was wrong, and only a real provider could say so.

## Consequences

- Phase 3 acceptance criteria 1 (buildable extension), 2 (end-to-end TypeScript scenario), and 3
  (multi-file rename) are demonstrated rather than argued. The rename is verified on disk, across
  exactly the three files the language contract names.
- The suite is fast once VS Code is cached (about one second of assertions), but the first run
  downloads roughly 300 MB and the cache directory reaches about 900 MB. Both are git-ignored.
- Extension-host coverage is deliberately thin: five tests over the paths that only a real host can
  settle. Detailed behaviour stays in the fast simulated-host suites, which do not need a GUI.
- Any future increment can now be checked against a real provider before its expectations are
  written into a fixture.

## Alternatives considered

### Trust `.vscodeignore` without inspecting the archive

Rejected. It is the kind of configuration that silently stops matching after a directory is renamed,
and the failure mode is shipping sources to users.

### Restate the scenario's expectations inside the test

Rejected. The test would then assert that the implementation does what the implementation does. The
`π` discrepancy would have been invisible, because the test would have been written from the same
mistaken assumption as the fixture.

### Copy the fixture project to a temporary directory for the run

Reasonable, and rejected for this increment: the language service's behaviour depends on the
project's own `tsconfig.json` and layout, and running against the real fixture in place is what
makes the result comparable to the declared contract. Snapshot-and-restore keeps the tree clean.
