# jetbrains-plugin/

## Responsibility

The JetBrains adapter: an IntelliJ Platform plugin that connects each open project to the daemon as a
workspace and answers IDEBP requests using the IDE's own engines — its indexes, its inspections, its
refactorings.

## Design

**Hand-written against the same contract.** No code is shared with the TypeScript packages; the wire
types are re-declared in Kotlin and held to the contract by `protocol/WireConformanceTest` and the
shared fixtures. Three languages cannot share one generator, so they share fixtures instead.

**The IDE's engines, or an honest refusal.** A rename is `RefactoringFactory`'s, a quick fix is the
inspection's own, a symbol's kind comes from the platform's description of it. Where the IDE cannot
answer, the adapter says so by name — `CAPABILITY_UNAVAILABLE` for a language no plugin claims,
`INDEX_NOT_READY` while the index is building — rather than answering emptily.

**Never claim what is not implemented.** `AdapterRegistration` builds its capability map from the
methods the router actually serves; a method with no handler is advertised as pending.

**Internal platform API is baselined, not banned by hope.** `internal-api-baseline.txt` plus
`checkInternalApiSurface` keep the surface to the two symbols required to read diagnostics; `javap`
is not authoritative for `@ApiStatus.Internal` and misled twice.

## Flow

```
lifecycle/     project opened → BridgeStartupActivity → link
service/       BridgeDaemonConnectionService: discovery → transport → handshake → register →
               serving thread + readiness watchdog + document-change announcer
connection/    WebSocketTransport (loopback, one send at a time), HandshakeClient, RpcClient,
               AdapterRouter — the method table
service/       AdapterBackend — every route's implementation, over platform/ helpers
platform/      the IntelliJ side: symbols, search, diagnostics, rename, undo, todos, bookmarks
workspace/     workspace model, URI containment, readiness model and its watchdog
ui/            tool window: what is linked, and the JUNON dashboards it can offer
```

## Integration

Built with Gradle and the IntelliJ Platform Gradle Plugin 2.x; `runIde` launches a sandbox IDE whose
sandbox lives under `~/.cache/ide-bridge/` rather than inside this project, because 1.9 GB of sandbox
inside the tree is 1.9 GB the IDE will index. `RealDaemonSymbolsTest` records the conformance capture
this repository judges the adapter by.
