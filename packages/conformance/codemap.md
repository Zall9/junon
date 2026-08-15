# packages/conformance/

## Responsibility

Judges what adapters actually answered. The invariants here are the ones a contract cannot express in
a schema — that a rename reports every document it changed, that a symbol's ranges lie inside its
declaration, that an apply either satisfies its preconditions or refuses.

## Design

**It judges captures, not live adapters.** Each adapter's own end-to-end run records what it
answered into `captures/{jetbrains,vscode}.json`; these tests read those files. That keeps the
judgement identical for both IDEs and runnable without either.

**Two captures, deliberately.** The invariants were once checked against JetBrains alone, so a
contract written to hold across IDEs was in practice checked against one. Both captures must be
present and non-empty, and a missing or hollow one fails rather than skipping — a capture that
quietly took five checks with it is a failure this package has already had.

**A capture attests to the run that produced it, not to the current code.** That is the known limit
of this whole approach, recorded in `docs/STATUS.md`: a stale capture passes. Re-record by running
each adapter's own suite.

## Flow

```
jetbrains-plugin RealDaemonSymbolsTest ──▶ captures/jetbrains.json
vscode-extension pnpm test:integration ──▶ captures/vscode.json
                                             │
                            tests/captured-adapters.test.ts
                            tests/edit-invariants.test.ts
                            tests/symbol-locations.test.ts
                                             │
                                    src/invariants.ts — the rules themselves
```

## Integration

`src/invariants.ts` is the shared statement of the rules; the daemon enforces the same properties at
runtime, and this package is where they are stated once and checked against both adapters at rest.
