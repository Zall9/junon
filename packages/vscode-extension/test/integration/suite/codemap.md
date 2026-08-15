# vscode-extension/test/integration/suite/

## Responsibility

The end-to-end scenarios themselves, run inside a real extension host: TASK.md §30 steps 4 through
12, plus the conformance capture they record.

## Design

**It proves which daemon answered.** The consumer resolves its discovery file the same way the
extension does, and the extension logs `daemon-autostarted` when it owns the daemon — the one line
that separates a suite testing this build from one testing whatever was left running.

**It observes, rather than inferring.** Step 12 subscribes to `document/changed` on its own consumer
connection, because "the plan was not invalidated" and "the daemon was never told" are otherwise the
same observation.

**Both refusal codes are accepted where the protocol allows both.** Step 12 passes on
`STALE_DOCUMENT` or `PRECONDITION_FAILED`: one is the daemon refusing from its own record, the other
an adapter refusing on its precondition, and both are correct.

## Flow

```
index.ts       mocha runner inside the extension host
e2e.test.ts    workspace conformance → document read → symbols → search + references → hierarchy
               → rename across files → stale plan refused → a read outside every root refused
               → records packages/conformance/captures/vscode.json
```

## Integration

The capture written here is what `packages/conformance` judges the VS Code adapter by; it attests to
this run, not to the current code.
