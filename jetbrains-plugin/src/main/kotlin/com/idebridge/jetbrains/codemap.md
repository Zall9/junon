# com/idebridge/jetbrains/

## Responsibility

Every part of the JetBrains adapter, split so that the IDE-facing code and the protocol-facing code
never blur into each other.

## Design

**Two sides, one seam.** `platform/` speaks to IntelliJ and knows nothing of the wire; `protocol/`
declares the wire and knows nothing of IntelliJ. `service/AdapterBackend` is the only place they
meet, which is why it is the largest file here and why the seam is worth defending.

**A package per concern the protocol names.** `symbol/`, `document/`, `edit/`, `diagnostic/` and
`workspace/` correspond to families of methods, so a route's implementation is findable from its
method name.

## Flow

```
lifecycle/    project opened/closing → link / unlink
connection/   transport, handshake, RPC engine, AdapterRouter (the method table)
service/      BridgeDaemonConnectionService (one link per project) and AdapterBackend (the routes)
platform/     IntelliJ engines: symbols, search, navigation, hierarchy, diagnostics, rename, undo,
              todos, bookmarks, document edits, and the trackers that say when they are ready
symbol/       handles, locators, relocation — the identity a consumer holds across edits
document/     revisions, hashing, line index
edit/         the plan registry: what a prepared edit is and when it may still be claimed
diagnostic/   mapping IntelliJ highlights to protocol diagnostics and their offered fixes
workspace/    workspace model, URI containment, readiness model and watchdog
protocol/     the wire types, re-declared in Kotlin and held to the shared fixtures
ui/           the tool window
```

## Integration

`AdapterRouter` is the boundary: everything above it is JSON, everything below it is PSI. A route that
cannot be answered truthfully refuses by name rather than answering emptily — the rule the whole
adapter is built around.
