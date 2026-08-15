# vscode-extension/test/integration/

## Responsibility

Launches a real VS Code with this extension installed, opens the committed fixture project, runs the
end-to-end suite, and leaves the fixture exactly as it found it.

## Design

**The sandbox is configured here, not by hand.** `run-integration.ts` writes the test window's own
`settings.json` — including `ideBridge.logLevel: debug`, because a dropped notification is logged at
that level and a dropped notification is what this suite exists to catch. A settings file left in the
sandbox by hand would make one machine's run differ from everyone else's, which is the shape of the
defect that cost this project three days
([ADR-0037](../../../../docs/adr/0037-an-integration-test-must-name-the-process-that-answered.md)).

**The fixture is a contract, not scratch space.** The rename scenario writes to `examples/typescript-project`,
so the launcher snapshots those files before the run and restores them after.

**The discovery file is sandboxed** by `IDE_BRIDGE_DISCOVERY_FILE`, so the run owns its daemon. That
variable was dead configuration until 2026-08-14, and the suite spent three days measuring a daemon
nobody had built.

## Flow

```
run-integration.ts
   snapshot fixture → write sandbox settings → download/resolve VS Code
   → runTests(extensionDevelopmentPath, extensionTestsPath, launchArgs)
   → suite/index.ts → suite/e2e.test.ts
   → restore fixture
```

## Integration

The extension bundles the daemon, so `pnpm -r build` before running: rebuilding only the extension
leaves an older daemon inside it.
