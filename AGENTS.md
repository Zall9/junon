# IDE Bridge development rules

> **Authoritative rules for all agents working on this repository.** These rules are derived from `TASK.md` §6 and expanded with concrete validation commands and durable constraints. Read `docs/IMPLEMENTATION_PLAN.md` for phase status and `docs/adr/` for architectural decisions before making changes.

---

## Repository Map

> See `codemap.md` (root atlas) for the full structural map with per-directory codemaps.

| Directory                         | Responsibility                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/protocol/src/`          | JSON Schema 2020-12 wire contracts, generated TypeScript types, runtime Ajv validation        |
| `packages/bridge-daemon/src/`     | WebSocket JSON-RPC 2.0 server (loopback only, authenticated, plan store, structured logging)  |
| `packages/bridge-client/src/`     | Shared TypeScript client (discovery, auth, typed RPC, reconnection, inbound request handling) |
| `packages/cli/src/`               | CLI tool: daemon, status, adapters, workspaces, doctor commands                               |
| `packages/vscode-extension/src/`  | VS Code adapter (Phase 3 lifecycle, document reads/symbols, core events)                      |
| `packages/conformance/src/`       | IDE-independent conformance suite (Phase 0 skeleton)                                          |
| `jetbrains-plugin/src/`           | JetBrains IntelliJ Platform adapter in Kotlin (Phase 0 skeleton)                              |
| `integrations/serena/ide_bridge/` | Serena Python backend (Phase 0 skeleton)                                                      |
| `scripts/`                        | Protocol scripts: fixture validation, type generation                                         |

---

## 1. General

- Read the relevant protocol schemas and ADRs before changing public contracts.
- Keep protocol packages independent from VS Code, JetBrains, and Serena. The `packages/protocol` package must have zero imports from `vscode`, `@types/vscode`, JetBrains SDK, or any Serena code.
- Prefer small, composable components. One responsibility per module.
- Do not hide unsupported capabilities behind approximate implementations.
- Never describe a textual edit as semantic. A `raw-text` or `anchored-text` operation must never be labelled `semantic` or `syntactic`.
- Never commit, push, publish, or create releases. Leave all changes uncommitted in the working tree.
- Do not create pull requests, merge requests, or modify any remote repository.
- Do not modify `TASK.md`. It is the authoritative product scope.
- Do not modify `.idea/` metadata.

---

## 2. Protocol and Schema Independence

- JSON Schema 2020-12 is the canonical wire-contract definition. TypeScript types are generated from schemas, not the reverse.
- Every public request, response, event, and error must have a schema.
- All protocol changes require fixtures and compatibility tests.
- New breaking changes require a protocol version decision and an ADR.
- URI values must not be converted to local paths without an explicit mapper. Preserve the original URI across all operations.
- Every edit must carry revision preconditions.
- The protocol package (`packages/protocol`) must not import IDE-specific or Serena-specific types.
- Schema validation at runtime uses Ajv 2020-12 via `ajv/dist/2020.js` (validated during Phase 0, 2026-08-01).

---

## 3. IDE Threading

- **VS Code:** Do not block the extension host. Use async APIs. Long operations must yield.
- **JetBrains:** No heavy PSI work on the EDT (Event Dispatch Thread). Use background read actions. Wait for smart mode before index operations. Use write commands for modifications. Check PSI element validity before access. Cancel tasks when project closes.
- Do not expose PSI objects or VS Code internal objects in the protocol. Always map to IDEBP DTOs.

---

## 4. Security

- The daemon listens on loopback only (`127.0.0.1` and/or `::1`). Never expose on a public interface.
- Token must be at least 256 bits, generated with a cryptographically secure RNG.
- Discovery file must have the most restrictive permissions possible (`0600` on Unix).
- Never log: authentication secrets, full file contents, full replacement text, sensitive diagnostic data.
- No method may execute arbitrary shell commands, IDE commands, or evaluate arbitrary JavaScript/Kotlin.
- No method may access files outside a workspace without explicit permission.
- Workspace trust must not be silently disabled.

---

## 5. Prepare / Apply (Two-Phase Edits)

- All semantic modifications must use two phases: prepare → apply.
- Write operations must use prepare/apply. No direct offset-based edits for semantic operations.
- Plans must expire and be rejected when preconditions are stale.
- Plans are: bound to an adapter, session, and workspace; non-reusable after application; automatically expired; explicitly discardable; invalidated on relevant changes.
- Before applying: check expiration, session, workspace, preconditions, permissions, revisions. Prevent plan reuse.
- After applying: return modified documents, before/after hashes, invalidate handles, return undo token when available.
- Do not apply raw offset-based edits when a semantic or syntax-aware operation exists.
- Never fall back to text modification when an adapter refuses a semantic operation. Any fallback must be explicitly configured, announced, and carry its guarantee level.

---

## 6. Testing

- Never declare a feature complete without running the corresponding tests.
- For each phase: implement → format → lint → typecheck → unit tests → integration tests → fix errors → document results.
- Mocks are allowed in unit tests. The MVP must include at least one real integration path per IDE.
- Do not delete tests to make CI pass.
- Do not reduce scope silently.

---

## 7. TypeScript Validation

> Commands confirmed during Phase 0 (2026-08-01). pnpm 10.32.1 validated.

```bash
pnpm install --frozen-lockfile   # Install with frozen lockfile
pnpm format:check                # Prettier check
pnpm lint                        # ESLint
pnpm typecheck                   # tsc --noEmit in strict mode
pnpm test                        # Vitest (all projects)
```

Per-package:

```bash
pnpm --filter @ide-bridge/protocol test
pnpm --filter @ide-bridge/bridge-daemon test
pnpm --filter @ide-bridge/bridge-client test
pnpm --filter @ide-bridge/cli test
pnpm --filter vscode-extension test
pnpm --filter @ide-bridge/conformance test
```

Schema fixture validation:

```bash
node scripts/check-protocol-fixtures.ts
```

VS Code extension packaging and real-host validation:

```bash
pnpm --filter vscode-extension package           # VSIX + automated archive inspection
pnpm --filter vscode-extension test:integration  # real extension host (VS Code 1.131.0 verified)
```

> **Note:** `test:integration` downloads a real VS Code (~300 MB, cached in `.vscode-test/`) and
> needs a GUI session — it cannot run on a headless CI runner. It opens `examples/typescript-project`
> and performs a rename that writes to those files; the launcher snapshots and restores them.

---

## 8. JetBrains Validation

> Commands confirmed during Phase 0 (2026-08-01). Gradle 9.0, JBR 21, Kotlin 2.1.20, IntelliJ Platform 2025.2 validated.

```bash
cd jetbrains-plugin
./gradlew test              # Unit tests
./gradlew buildPlugin       # Build + static checks
./gradlew runIde            # Sandbox integration (requires display — see R11 in IMPLEMENTATION_PLAN.md)
```

> **JAVA_HOME note:** Local Gradle runs require `JAVA_HOME` set to the local JBR (JetBrains Runtime) bundled with the IntelliJ installation. If `JAVA_HOME` is not set to JBR, Gradle may fail to find a compatible JDK. Example: `export JAVA_HOME="/Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Home"` (adjust path to your IntelliJ installation).

Gradle formatting and static checks are defined by the IntelliJ Platform Gradle Plugin 2.x configuration (Kotlin 2.1.20, IntelliJ 2025.2, Gradle wrapper 9.0 — all confirmed in Phase 0).

---

## 9. Python Validation

> Command confirmed during Phase 0 (2026-08-01). Python 3.14.6 validated; 54 tests pass.

```bash
cd integrations/serena
python3 -m pytest                    # Unit tests
python3 -m pytest --integration      # Integration with live daemon
```

> **Fallback:** If system `python3` is unsuitable or missing dependencies, use the venv:
>
> ```bash
> cd integrations/serena
> .venv/bin/python -m pytest
> .venv/bin/python -m pytest --integration
> ```

Python >= 3.12 required (or Serena-imposed version; package metadata declares >=3.12, validated during Phase 0 against Python 3.14.6).

---

## 10. Versions

`VERSION` at the repository root is the product's version. **Never edit one of its copies by hand.**
Gradle, six `package.json` files, `pyproject.toml` and a Kotlin constant each hold the same number
because each build system wants it in its own file; three guards fail when one drifts
(`packages/bridge-daemon/tests/metadata.test.ts`, `PluginVersionTest.kt`,
`integrations/serena/tests/test_version_identity.py`).

The number must stay orderable — `MAJOR.MINOR.PATCH`, no `-SNAPSHOT`. A JetBrains IDE decides
whether an update exists by comparing this string, and a suffix makes that question unanswerable.
Seven copies existed before this rule, no two agreeing, which is why nothing could tell a user that
one half of their installation was older than the other.

To cut a release, see [docs/RELEASING.md](docs/RELEASING.md).

## 11. Plan Maintenance

- `docs/IMPLEMENTATION_PLAN.md` is the canonical living plan. Update phase status and log after every phase increment.
- Update the plan when: a phase starts, a phase completes, acceptance criteria change, risks are discovered or resolved, toolchain baselines are confirmed or changed.
- Create or update an ADR when a decision affects: the protocol, compatibility, security, transaction model, transport, symbol representation, or edit operations.
- Mark outdated ADRs as superseded with a link to the replacement. Never delete an ADR.
- Record evidence (test output, build results, log excerpts) in the working tree for each phase completion.

---

## 12. Use the IDE Before Reading the Disk

This repository builds JUNON, and the fastest way to find its defects is to work through it. When an
IDE is connected, prefer the `ide_*` tools over `read`, `grep` and `glob`.

They are served by the MCP named **`serena`**, which is started as `junon start-mcp-server` — plain
`serena` publishes none of them. `ide_status` says whether an IDE is connected and what it has open;
call it first, because every other `ide_*` tool refuses without one.

| Instead of                         | Use                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `read` a file                      | `ide_read_document` — the file **as the editor holds it**, unsaved edits included |
| `read` then hunt for a declaration | `ide_read_symbol` — one declaration, cut to the IDE's own range                   |
| `grep` for a definition            | `ide_find_symbol` — the IDE's symbol index, narrowed by kind                      |
| `read` to see a file's shape       | `ide_symbols_overview`                                                            |
| `grep` for callers                 | `ide_hierarchy` — callers, callees, supertypes, subtypes                          |
| Guessing whether a change holds    | `ide_diagnostics` — real inspections, with the fixes offered                      |
| `grep -r TODO`                     | `ide_todos` — as the IDE recognises them, not as a search guesses                 |

`ide_apply_fix` applies a fix `ide_diagnostics` offered; `confirm` separates looking from doing. It
is **not** a general editor — writing code remains `edit`/`write`. Ask the IDE what is true, edit
with your own tools, then ask `ide_diagnostics` what you broke.

A refusal from these tools is information about this product, not an obstacle to route around. If a
route refuses, or answers something a text search contradicts, that is a defect worth reporting
before falling back to `read`/`grep` — and say in your summary that you fell back, so a green result
is never mistaken for one the IDE confirmed.

---

## 13. Git Constraints (Non-Negotiable)

- Never create a commit.
- Never modify a commit.
- Never push a branch.
- Never create a release.
- Never publish a package.
- Never create a pull request or merge request.
- Never modify a remote repository.
- Leave all changes uncommitted in the working tree.
- Provide a precise summary of changes at the end.
