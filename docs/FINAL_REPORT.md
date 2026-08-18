# Final report

TASK.md §33. Every number here was measured on 2026-08-15, not recalled; where something is wired but
unproven, it says so rather than being counted as working.

## Summary

### Architecture implemented

IDEBP is a JSON-RPC protocol over an authenticated loopback WebSocket. The daemon is the only
stateful party: adapters and consumers both connect to it as clients and never see each other, and
every identifier that crosses it — plan ids, undo tokens, symbol handles — is rewritten on the way
through, so an adapter's private identifiers never reach a consumer.

```
consumer ──▶ bridge-client ──▶ bridge-daemon ──▶ bridge-client ──▶ adapter
   (cli, conformance,              │                                (vscode-extension
    JUNON/Serena)                  ├─ session/  registry, trust, roles
                                   ├─ routing/  the one place a request becomes an answer
                                   ├─ plan/     plans, undo tokens, and why one went away
                                   └─ security/ loopback binding, 0600 discovery, token
                                                                    jetbrains-plugin)
```

The wire contract lives in `packages/protocol` as JSON Schemas; TypeScript types are generated from
them and never the reverse. Kotlin and Python re-declare the same shapes by hand — three languages
cannot share one generator — and are held to the contract by fixtures both stacks read.

### Operational

- **The daemon**: discovery file written `0600`, token ≥ 256 bits, loopback only, two roles, routing
  with timeouts and cancellation, plan store with expiry and invalidation, read-only dashboard.
- **Both adapters register and serve**: VS Code and JetBrains each expose capabilities derived from
  the handlers they actually have, and answer documents, symbols, search, references, hierarchy,
  diagnostics, TODOs and bookmarks.
- **Edits, two-phase, on both**: `refactor/prepare`, `prepareRename`, `applyPlan`, `discardPlan`,
  `undo`. A cross-file rename prepares, applies, reports every document it changed, and can be
  undone.
- **A stale plan is refused before anything is written**, on both adapters — `STALE_DOCUMENT`
  carrying the revision to prepare against when the daemon knows, `PRECONDITION_FAILED` from the
  adapter when only it does. TASK.md §30 step 12 passes on both.
- **Readiness**: JetBrains probes every 5 s and reports `indexing`, `ready` or `degraded`; VS Code
  announces `ready`. `degraded` is the first any adapter here has emitted.
- **Notifications**: the JetBrains adapter sends the §12 vocabulary — workspace readiness, and
  `document/opened|changed|saved|closed|renamed|deleted` plus `diagnostics/changed`.
- **JUNON**: nine `ide_*` tools composed onto Serena at run time, without editing it.
- **Conformance**: invariants judged against captures both adapters record from their own runs.

### Partial

- **Four JetBrains notifications are wired but not driven end to end**: `document/opened`, `closed`
  and `renamed`. Their triggers are gestures a person makes in the IDE, and doing them through the
  file system does not reach it. Their *payloads* are proven against the schema on both stacks.
- **Typing is forwarded, external edits are not seen promptly.** An edit made on disk outside the IDE
  reaches it on no reliable schedule — measured at 45 s in one run and never within 90 s in another.
  `applyPlan` refreshes the files its plan names before checking them, so a plan is not written over
  such an edit; reads are not protected the same way.
- **VS Code reports neither `indexing` nor `degraded`.** It exposes no index-readiness signal, and its
  extension host has one thread, so a watchdog could not run while the thing it watches is blocked.
- **JetBrains does not reconnect** after the daemon closes its session. It now *notices*, releases the
  link and reports `DISCONNECTED`; re-linking is the user's action.

### Deferred (TASK.md §29)

Debugger, breakpoints, runtime evaluation, inline method, move class, safe delete, change signature,
method extraction, generic symbolic editing, multi-user collaboration, durable plan persistence,
public network transport, application-level encryption, full browser support, all-language support,
marketplace publication, auto-update, telemetry. The roadmap §29 asks for is
`docs/ARCHITECTURE.md` §17.

## Principal files

| Area | File | What it carries |
| --- | --- | --- |
| Contract | `packages/protocol/schemas/**` | every message shape, the only definition |
| | `packages/protocol/fixtures/**` | what keeps three implementations honest |
| Daemon | `packages/bridge-daemon/src/routing/application-router.ts` | the single place a request becomes an answer |
| | `packages/bridge-daemon/src/plan/in-memory-edit-store.ts` | plans, undo tokens, and why a plan went away |
| | `packages/bridge-daemon/src/session/session-registry.ts` | adapters, workspaces, trust, readiness |
| Client | `packages/bridge-client/src/connection/**` | handshake, engine, reconnection |
| VS Code | `packages/vscode-extension/src/event-bridge.ts` | events, readiness, and the eight named drops |
| | `packages/vscode-extension/src/document-routes.ts` | documents, and why one cannot be described |
| | `packages/vscode-extension/src/configuration.ts` | discovery resolution (ADR-0037) |
| JetBrains | `.../service/AdapterBackend.kt` | every route, over the IDE's own engines |
| | `.../service/BridgeDaemonConnectionService.kt` | one link per project: session, watchdog, listeners |
| | `.../workspace/ReadinessWatchdog.kt` | notices when the IDE stops answering |
| | `.../connection/WebSocketTransport.kt` | loopback, one send at a time |
| JUNON | `integrations/serena/junon/tools.py` | the `ide_*` tools and their refusal advice |
| | `integrations/serena/junon/client.py` | discovery, handshake, sessions |
| CLI | `packages/cli/src/doctor.ts` | health, and *which* daemon answered |
| Decisions | `docs/adr/**` (39) | why, with the measurement behind it |
| State | `docs/STATUS.md`, `docs/DEMO.md` | what is proved, and what is not |

## Validation

Run on 2026-08-15. Results as they came back.

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm -r build` | pass |
| `pnpm cli:smoke` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | **469 passed**, 53 files |
| `pnpm protocol:fixtures` | pass |
| `pnpm protocol:generate:check` | pass |
| `pnpm exec tsc --noEmit -p examples/typescript-project/tsconfig.json` | pass |
| `cd jetbrains-plugin && ./gradlew test` | **278 passed**, 54 classes |
| `./gradlew buildPlugin` | pass |
| `./gradlew checkInternalApiSurface` | 16 usages, all accounted for by 2 baseline entries, across 4 IDEs |
| `cd integrations/serena && .venv/bin/python -m pytest -q` | **143 passed** |
| `cd packages/vscode-extension && pnpm test:integration` | **9 passing** (real VS Code, real daemon) |

Beyond the suites, measured against running IDEs:

- **JetBrains §30 step 12**: a two-file rename applied, then the six-file plan prepared before it
  refused `STALE_DOCUMENT`, `retryable: false`; undo accepted.
- **Notifications**: one rename with its undo produced `document/changed` ×19, `document/saved` ×12,
  `diagnostics/changed` ×2; the daemon's metrics also record `document/deleted` ×2.
- **Readiness**: opening a project logged `smart → dumb → blocked → smart`. All four moments read
  `ready` before the watchdog existed.
- **No secrets in logs**: 103 log files — 8.3 MB of daemon log, 3.9 MB of IDE log, the VS Code
  extension host — searched for the two live tokens. **Zero occurrences.**

## Demonstration

```bash
# Install
pnpm install --frozen-lockfile
pnpm -r build

# Daemon (leave running; every command below reads the same variable)
export IDE_BRIDGE_DISCOVERY_FILE=/tmp/ide-bridge-demo.json
node packages/cli/dist/bin.js daemon --dashboard
node packages/cli/dist/bin.js doctor      # which daemon answered, and since when

# VS Code — launches a real editor, runs the end-to-end suite, restores the fixture
cd packages/vscode-extension && pnpm test:integration

# JetBrains — a sandbox IDE with the plugin, on a project that has source roots
cd jetbrains-plugin
IDE_BRIDGE_SAMPLE_PROJECT=$PWD ./gradlew runIde     # runPhpStorm / runPyCharm / runGoLand

# Tests
pnpm test                                            # TypeScript
cd jetbrains-plugin && ./gradlew test                # Kotlin
cd integrations/serena && .venv/bin/python -m pytest # Python

# Serena integration
junon start-mcp-server --project <path> --transport stdio
junon tools list | grep '^ \* `ide_'
```

`docs/DEMO.md` carries the same walkthrough with the output each step actually produced.

## Remaining risks

Stated at full strength.

1. **A conformance capture attests to the run that produced it, not to the current code.** A stale
   capture passes. Both were re-recorded on 2026-08-15, and nothing prevents them going stale again.
2. **Reads can describe a file the disk no longer has.** The IDE's view lags external edits by up to
   a minute or more; symbols and diagnostics are computed against that view. Only the apply path
   refreshes first.
3. **Four notifications have never been observed leaving the adapter.** Their shapes are verified,
   their triggers are not.
4. **JetBrains does not reconnect by itself**, and a session the daemon closes ends the link until a
   user re-links.
5. **No adapter has been run against a language plugin this project did not test.** Everything is
   measured against bundled language support; a third-party plugin's symbols, kinds and fixes are
   unknown territory.
6. **Remote development is designed, not implemented** (`docs/REMOTE_DEVELOPMENT.md`).
7. **The plugin depends on two internal platform symbols** to read diagnostics, baselined with a
   reason (ADR-0027). An IDE upgrade may remove them.
8. **Single-machine, single-user, loopback only.** Nothing here has been tested under concurrent
   consumers beyond the daemon's own bounds, and plans do not survive a daemon restart by design.

## Git

TASK.md §33 asks this section to confirm that no commit was created. **That is no longer true, and
the difference is deliberate**: on 2026-08-15 the user lifted the prohibition explicitly — *"ok git
init puis commite mais ne co authore pas"* — so what follows is the state as it is.

- `git init` was run; the repository is on branch `main`.
- **Eighteen commits exist as of 2026-08-17**; the first carried 585 files. This line read "two
  commits" until that date, having stopped being true within a day of being written — so it now
  carries the date that makes it checkable, rather than a number that rots in silence.
- **No commit hash is quoted here.** Two were, and they are exactly what an ordinary operation on
  this history invalidates — rewriting it to drop the signatures, which is what happened on
  2026-08-17. A reference that cannot survive the thing it describes is worse than no reference,
  because it goes on reading as correct.
- **The prohibition on remote operations was lifted on 2026-08-17**, explicitly and by the user.
  The repository is pushed over SSH to a **public** GitHub remote, `Zall9/junon`. Nothing had been
  pushed before that, and no remote existed until then.
- **No commit is signed.** Every one was, until that day: a global `commit.gpgsign` signed them
  without being asked. The signatures were removed by rewriting every commit object, which is also
  why no hash in this document survived.
- **No co-author or generated-by trailer** appears in any commit, as asked.
- The working tree is clean: everything is in the commits, nothing is stranded.
- `.gitignore` was extended before the first commit so that `git init` did not capture build
  detritus — stray IntelliJ `.class` files, `*.tsbuildinfo` caches, a generated codemap carrying
  absolute paths, `.DS_Store`, Serena's session logs. `.serena/memories/` was kept deliberately.
