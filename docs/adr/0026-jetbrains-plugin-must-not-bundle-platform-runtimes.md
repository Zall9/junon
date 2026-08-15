# ADR-0026: The JetBrains plugin must not bundle runtimes the platform provides

- Status: accepted
- Date: 2026-08-02
- Supersedes: none
- Related: [ADR-0024](0024-kotlin-protocol-types.md), [ADR-0025](0025-cross-language-uri-vectors.md)

## Context

The JetBrains plugin is written in Kotlin and uses `kotlinx.serialization` for every wire type
(ADR-0024). Both the Kotlin standard library and `kotlinx.serialization` are also shipped **by the
IntelliJ Platform itself**, in `lib/util-8.jar`, which is loaded by the core class loader that is the
parent of every plugin class loader.

Until now the build declared:

```kotlin
implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
```

and `gradle.properties` contained:

```properties
kotlin.stdlib.dependency=false
```

That property name is **not** one the Kotlin Gradle Plugin recognises — the real one is
`kotlin.stdlib.default.dependency`. It therefore had no effect, and the standard library was added
and bundled as if nothing had been written.

The result was a distribution containing `kotlin-stdlib-2.1.20.jar`,
`kotlinx-serialization-core-jvm-1.7.3.jar` and `kotlinx-serialization-json-jvm-1.7.3.jar`. Because
the plugin's own jars are searched **before** the platform's, these copies shadowed the platform's,
and platform code compiled against a newer standard library failed at runtime:

```
NoSuchMethodError: kotlin.sequences.SequencesKt.sequenceOf(java.lang.Object)
AbstractMethodError: VSCodeExtension$$serializer does not define or inherit
                     GeneratedSerializer.typeParametersSerializers()
```

This was invisible for as long as nothing exercised the platform. It surfaced the moment a platform
test fixture started a real project: indexing died on those errors, its `IncompleteTaskToken` was
never completed, and `IndexingTestUtil.waitUntilIndexesAreReady` waited forever. The symptom read as
"platform test fixtures hang", and was twice misattributed — first to the project's JUnit Vintage
test configuration, then to one-off artifact resolution — before a thread dump and the sandbox log
identified it.

The defect was never confined to tests. A shipped plugin that shadows the platform's Kotlin runtime
breaks the IDE for the user.

## Decision

The plugin bundles **nothing the platform already provides**.

- `kotlin.stdlib.default.dependency=false` — the correct property, so the standard library comes from
  the platform.
- `kotlinx-serialization-json` is `compileOnly`: needed to compile against, supplied at runtime by
  the platform.
- `kotlin("test")` re-adds the standard library transitively to the test runtime, so it is excluded
  from `testRuntimeClasspath`. Tests then run against exactly the runtime the plugin will use in an
  IDE.
- The distribution is expected to contain one jar, the plugin's own. Anything else is a regression.

Binary compatibility is verified with the IntelliJ Plugin Verifier against the target IDE, which is
what distinguishes "resolvable in the test runtime" from "resolvable in a real plugin class loader".

## Consequences

**The wire types are now validated against the runtime that will actually deserialize them.** The
conformance suite (ADR-0024) no longer runs against a version we pinned; it runs against the
platform's. A future platform whose serialization runtime is incompatible with the serializers the
Kotlin 2.1.20 plugin generates would fail that suite rather than fail a user.

**The platform's version is not ours to choose.** This is the real cost of the decision: the plugin
depends on a runtime whose version is set by the IDE, and `sinceBuild` is what bounds it. Bundling
would give control of the version, but at the price of breaking the host — demonstrably, since that
is what was happening.

**Test coverage of the platform boundary became possible.** With the conflict removed,
`BasePlatformTestCase` runs headlessly in a few seconds. `IntelliJProjectSnapshotTest` exercises the
one file that reads live IDE state — content roots as URIs rather than local paths, the three-state
trust API, the mapping to a protocol workspace, root-id stability, and dumb-mode readiness — closing
the gap that ADR-0024 had deferred to a sandboxed IDE run.

**A non-URI content root is now refused locally.** Mutating the snapshot to report `it.path` instead
of `it.url` is caught by the new tests, and revealed that `WorkspaceModel` would have passed such a
root through to the wire, where the daemon answers a URI it cannot authorize by closing the session.
The model now rejects it, next to the duplicate-root check that was already there.

## What binary verification then found

Running the verifier for the first time was only possible once the bundling was fixed, and it
immediately rejected three things the compiler had accepted:

**`TrustedProjects.getProjectTrustedState` is `@ApiStatus.Internal`** — every overload of it. The
only public reader of workspace trust is the boolean `isProjectTrusted`. The adapter now uses the
public one, which **costs the `UNDECIDED` distinction** that ADR-0024 deliberately preserved: a
project whose trust has not been decided is now reported as denied. This is a loss of fidelity, not
of safety — the daemon permits writes only on `trusted`, so an undecided project is refused either
way — but it is a real reduction and is recorded as such rather than presented as equivalent.

The protocol keeps `unknown`. It is currently produced by no adapter, since VS Code's
`workspace.isTrusted` is also a boolean. It is retained because it is the honest answer for an
adapter that *can* observe the distinction, and because removing a wire value is a change to the
contract that should not be driven by one platform's annotation policy.

**`AppLifecycleListener.appStarted` is internal and `ProjectManagerListener.projectOpened` is
deprecated for removal.** Both were replaced by a single `postStartupActivity` implementing
`ProjectActivity`, which is public, supported, and runs off the EDT by construction — so the
explicit pooled-thread hop the old listener needed to honour AGENTS.md §3 is gone. `appClosing` and
`projectClosing` are neither internal nor deprecated and stay where they were.

**93 deprecated-API usages remain, all of one kind:**
`GeneratedSerializer.DefaultImpls.typeParametersSerializers`, emitted by the Kotlin serialization
compiler plugin once per `@Serializable` class. It is compiler-generated, not written here, and
deprecated rather than removed in the platform's runtime. It is left alone; it would change only by
moving to a serialization plugin aligned with the platform's own runtime version.

## Alternatives considered

**Shading the bundled copies.** Relocating `kotlin.*` and `kotlinx.serialization.*` into a private
namespace would let the plugin pin its own versions without shadowing the platform. Rejected: it
roughly doubles the artifact for no behaviour the platform's own runtime does not already provide,
and every serializable type would still have to agree with the protocol schemas, which is what
actually constrains the wire format.

**Keeping the bundled copies and accepting the platform errors.** Not viable — the failures are in
platform code, not ours, and the user pays for them.
