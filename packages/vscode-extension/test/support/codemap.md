# vscode-extension/test/support/

## Responsibility

The two helpers the tests need and should not each reinvent: a type for asserting on a refusal, and a
way to find the repository root.

## Design

**A refusal is asserted partially, and deliberately so.** `ExpectedAdapterError` is a _recursive_
partial of `BridgeAdapterRequestError`, because `toMatchObject` compares nested objects partially and
a plain `Partial<…>` would only loosen the top level. Protocol error variants such as
`StaleDocumentErrorData` require `details.currentRevision`, which an assertion has no business
pinning: what matters is the code, not the revision the daemon happened to compute.

**The root is found, not assumed.** This package compiles as CommonJS, so `import.meta.url` does not
exist, and `process.cwd()` differs between a filtered run and one started from the repository root.
`repositoryRoot()` ascends until it finds `pnpm-workspace.yaml`, which is true in both cases.

## Flow

```
expected-error.ts    ExpectedAdapterError — a deep partial of the client's error type
repository-root.ts   repositoryRoot() — walk up to the workspace marker, or throw
```

## Integration

Used by the unit tests. The integration suite has its own `rejectsWith` matcher, which names the
protocol codes a scenario will accept.
