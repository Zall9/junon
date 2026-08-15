# IDE Bridge for VS Code

Exposes this VS Code window to the IDE Bridge Protocol (IDEBP) so an external agent can read
documents, query symbols, collect diagnostics, and perform semantic renames — over an authenticated
loopback connection, with revision preconditions on every write.

## What it does

| Area        | Operations                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Documents   | `document/read`, `document/getRevision`                                                                        |
| Symbols     | `document/getSymbols`, `workspace/searchSymbols`, `symbol/resolveAt`, `symbol/getDefinition`, `symbol/getReferences`, `symbol/getImplementations` |
| Diagnostics | `diagnostics/getSnapshot`                                                                                      |
| Refactoring | `refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`                                       |

`workspace/undo` is **not** available: the VS Code extension API exposes no way to revert an applied
workspace edit (ADR-0021).

## Things worth knowing before you use it

- **Applying a plan writes to disk and cannot be undone through IDE Bridge.** Every prepared plan
  carries a warning saying so. Neither undo nor close-without-saving is available afterwards.
- **Writes require a trusted workspace.** In an untrusted window all read operations keep working and
  every write is refused with `PERMISSION_DENIED`.
- **The daemon listens on loopback only**, authenticated with a token held in a `0600` discovery
  file. There is no option to expose it on a public interface.
- **Events cover what the editor observes.** Files renamed or deleted outside VS Code emit no event,
  though the affected symbol handles and prepared plans are still invalidated.

## Settings

| Setting                       | Default | Meaning                                               |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `ideBridge.autoStartDaemon`   | `true`  | Start a local daemon when none is running (Unix only)  |
| `ideBridge.manualEndpoint`    | _empty_ | Connect to an existing daemon; must be loopback        |
| `ideBridge.discoveryFile`     | _empty_ | Override the private discovery file location           |
| `ideBridge.logLevel`          | `info`  | `error`, `warn`, `info`, or `debug`                    |
| `ideBridge.providerTimeoutMs` | `30000` | Provider call timeout in milliseconds (100–300000)     |

Logs are written to the "IDE Bridge" output channel and never contain document content, diagnostic
text, or authentication material.
