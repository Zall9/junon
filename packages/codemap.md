# packages/

## Responsibility

The TypeScript half of IDE Bridge: the wire contract, the daemon that routes it, the client both
ends use, the VS Code adapter, the CLI, and the conformance judge. The JetBrains adapter lives
outside this tree (`jetbrains-plugin/`) and speaks the same contract from Kotlin.

## Design

**One contract, generated downhill.** `protocol/` owns the JSON Schemas; TypeScript types are
generated _from_ them and never the reverse. Kotlin and Python re-declare the same shapes by hand and
are held to them by conformance fixtures, because three languages cannot share one generator.

**The daemon is the only stateful party.** Adapters and consumers both connect to it as clients; they
never see each other. Plan identifiers, undo tokens and symbol handles are rewritten as they pass
through, so an adapter's private identifiers never reach a consumer.

**Every package is a boundary, not a layer.** `bridge-client` knows nothing of workspaces;
`bridge-daemon` knows nothing of VS Code; `conformance` knows nothing of either beyond the captures
it judges.

## Flow

```
protocol  ──generates──▶  generated.ts ──used by──▶ every other package
   │
   └─ schemas/ ◀──validated against── fixtures/

consumer ──▶ bridge-client ──▶ bridge-daemon ──▶ bridge-client ──▶ adapter
                                    │                                (vscode-extension
                                    ├─ plan/      plans, undo tokens   or jetbrains-plugin)
                                    ├─ session/   registry, trust
                                    └─ routing/   the one place a request becomes an answer
```

`cli/` is a consumer like any other: `status`, `adapters`, `workspaces`, `doctor`. `conformance/`
judges what adapters actually answered, from captures recorded by their own end-to-end runs.

## Integration

`pnpm -r build` builds in dependency order; the VS Code extension **bundles** the daemon, so a stale
`dist` there means the extension ships an old daemon — a trap that has cost this project days. See
[ADR-0037](../docs/adr/0037-an-integration-test-must-name-the-process-that-answered.md).
