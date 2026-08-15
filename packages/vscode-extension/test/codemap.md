# vscode-extension/test/

## Responsibility

Two kinds of test, kept apart on purpose: unit tests that drive the extension's own classes against
fakes, and an integration suite that launches a real VS Code.

## Design

**Fakes for the editor, never for the contract.** The unit tests substitute VS Code's API surface —
documents, workspace folders, event emitters — but validate every notification they produce against
the real protocol classifier, so a test cannot pass on a message the daemon would reject.

**Each file pins a failure that happened in a real editor.** `event-bridge.test.ts` names the eight
reasons a document event may never be sent, because for a day a lost notification was
indistinguishable from a document that never changed. `symbol-relocation.test.ts` exists because a
near-miss relocation would silently retarget an edit.

**Mutation is the standard of proof here.** A test that still passes with its rule deleted is treated
as no test, and the reasons in `event-bridge.test.ts` were each proved by breaking them one at a
time.

## Flow

```
unit (this directory)
  event-bridge / document-routes / document-mapper   documents, revisions, and what is never sent
  symbol-* / diagnostic-routes / edit-routes         the routed methods
  capabilities / configuration-topology              what the adapter claims, and how it is configured
  daemon-process / adapter-lifecycle / extension-entry  starting, connecting, restoring, stopping

integration/  a real VS Code, a real daemon, a real fixture project
support/      helpers both kinds share
```

## Integration

`pnpm test` runs the unit tests; `pnpm test:integration` runs the other kind, and only the second
proves anything about a running editor.
