# test/…/protocol/

## Responsibility

Keeps the Kotlin re-declaration of the wire contract honest. The adapter cannot import the
TypeScript types, so these two files are what stop the two from drifting.

## Design

**Conformance against shared fixtures, not against a copy.** `WireConformanceTest` reads the same
`packages/protocol/fixtures` the TypeScript side validates, so a shape that changed in the schemas
fails here rather than at runtime in someone's IDE.

**Coverage is counted, not assumed.** `CatalogueCoverageTest` guards the method and notification
catalogues so adding a message is an acknowledged act; absorbing one silently is how a method ends up
declared and unimplemented.

## Flow

```
WireConformanceTest    serialise and parse every fixture the contract publishes
CatalogueCoverageTest  every method and notification the protocol names appears in the catalogue
```

## Integration

Fixtures come from `packages/protocol/fixtures/`; regenerating the schemas without rerunning these is
how the Kotlin side silently falls behind.
