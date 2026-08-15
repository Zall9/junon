# ADR-0024 — Kotlin protocol types, and one contract inconsistency they exposed

## Status

Accepted — 2026-08-02

Amends the `symbol/getImplementations` response contract defined in Phase 1.

## Context

The JetBrains plugin is Kotlin and cannot use the TypeScript `bridge-client`. It needs its own
representation of every IDEBP message. That creates the risk AGENTS.md §2 exists to prevent: a
second source of truth for a contract whose canonical form is JSON Schema.

Phase 4 as a whole is the scope of Phases 2 and 3 combined — a WebSocket JSON-RPC client, PSI
mapping, symbol handles over `SmartPsiElementPointer`, dumb-mode readiness, plans, diagnostics, and
threading discipline. This ADR covers only the first increment: the wire types and the guarantee
that they do not drift.

## Decision

### Hand-written types, guarded by the canonical fixtures

- The DTOs are hand-written `kotlinx.serialization` classes rather than generated. A generator would
  make drift structurally impossible, but it is a second tool to build and maintain for one
  consumer, and the awkward cases — `oneOf`, `minItems` tuples, optional versus nullable, constants
  — are exactly where a generator earns its cost and where a small one would be least trustworthy.
- Drift is caught instead by `WireConformanceTest`, which decodes every canonical fixture and
  re-encodes it, requiring identical JSON. A field the plugin forgot fails on the unknown key; a
  field it invents fails on the comparison.
- `CatalogueCoverageTest` reads the schemas directly and requires the Kotlin method and notification
  catalogues to match exactly, so a method added to the protocol fails this build rather than being
  silently unsupported.
- A fixture whose schema has no declared Kotlin serializer fails a dedicated test. Adding a fixture
  to the protocol therefore forces a decision here instead of passing unnoticed.

### JSON configuration is contract, not style

- `ignoreUnknownKeys = false` mirrors `additionalProperties: false`.
- `explicitNulls = false` keeps optional fields absent rather than `null`; optionality is carried by
  nullability alone.
- `encodeDefaults = true`, because required constants — `jsonrpc`, `method`, `type`, `kind` — are
  expressed as Kotlin defaults and must appear on the wire.
- Constant-valued fields are enforced in `init` blocks. A `String` with a default accepts any value
  on decode, which let a handshake fixture with the wrong method deserialize successfully until the
  conformance suite caught it.
- A JSON-RPC identifier is `string | integer` and is kept as a `JsonPrimitive`. Coercing it to text
  would change the value the peer correlates on.
- A handshake error's `id` is required and may be the JSON `null` literal. It is typed
  non-nullable so the literal is carried as `JsonNull` and always encoded — the one place the
  contract distinguishes an explicit null from an absent key.

## The inconsistency this exposed

Mapping the symbol methods surfaced a divergence: `symbol/getImplementations` declared a result of
`{ symbols: Symbol[] }`, while `symbol/getDefinition` and `symbol/getReferences` both used the
shared `symbolLocationsResponseBase` — `{ locations, truncated }`. TASK.md groups the three methods
everywhere and distinguishes none of them, and the shared base exists precisely for them, so the
divergence reads as a Phase 1 slip rather than a decision.

It was not merely cosmetic. The VS Code adapter implemented all three through one code path
returning `locations`, and the daemon validated all three as location results. A consumer calling
`symbol/getImplementations` would therefore have received `PROVIDER_FAILED` and cost the adapter its
session. TypeScript did not catch it because the handler's return type is a union across the three
methods, and `{ locations, truncated }` satisfies that union.

`symbol/getImplementations` now uses the shared base. This keeps the ADR-0018 reasoning intact —
navigation results are positions, not handle-bearing symbols, because minting a handle per
cross-document result is expensive and inherits the unverified-revision problem — and removes a
special case from the adapter, the daemon, and every future adapter. A parameterised daemon test now
routes all three methods through the shared shape and fails if any one of them diverges again.

## Consequences

- The plugin has a complete, compiling representation of the wire contract, with three tests that
  fail on drift rather than a convention that asks people to remember.
- Hand-written types remain a second expression of the contract. The guarantee is the test suite,
  not the declarations, which is why the coverage tests are as important as the DTOs.
- Constraint violations — ranges, lengths, patterns — are not enforced by the DTO layer and cannot
  be. The conformance suite lists those fixtures explicitly, so a new one fails until someone
  classifies it rather than being quietly assumed unenforceable. Runtime constraint validation
  belongs to a later increment; the daemon enforces them regardless.

## Increment 4b — discovery and handshake

The same discipline applies to the connection boundary.

- The discovery file is untrusted input even though the daemon wrote it. It is resolved without
  following symlinks, size-bounded, and refused when group or other permission bits are set. Its
  endpoint is re-validated as loopback here rather than trusted from the file, because connecting
  anywhere else would defeat the transport's only boundary.
- Failures carry a `Reason` and never file content: a malformed-file error message can echo the
  token, so the parse cause is deliberately discarded. A test asserts a secret-shaped value in a
  malformed file never appears in the outcome.
- `HandshakeClient` owns the message exchange and its validation, not the socket. The transport is
  an interface, so the protocol rules are testable without a network and the socket can be replaced
  without touching them.
- A typed refusal is a valid answer and is classified before the success shape; an unsupported
  version surfaces the range the daemon does support. Response identifier, granted role, and
  selected version are each checked before the session is treated as usable — a response answering
  a different request, or granting a different role, is not this session.
- The permission check, the loopback check, and the no-follow-symlink resolution were each confirmed
  by mutation: removing any one of them fails the Kotlin build.

## Increment 4c (partial) — transport and the real integration path

- The socket is the JDK's own `java.net.http.WebSocket` rather than a new dependency or IntelliJ's
  bundled Netty: fewer moving parts, and nothing platform-internal to break across IDE versions.
- Redirects are refused. A redirect would move the connection off the loopback endpoint the
  discovery file authorised, which is the transport's only boundary.
- The listener reassembles partial text frames. The JDK delivers a message in pieces, and handing a
  piece to the protocol layer would present malformed JSON as a contract violation. Binary frames
  are not part of the contract and end the connection.
- `RealDaemonHandshakeTest` starts the actual daemon process, reads the `0600` discovery file it
  publishes through the same guards production uses, and completes a genuine authenticated
  handshake over loopback — the real integration path AGENTS.md §6 requires per IDE. A second case
  presents a forged token and asserts the specific `AUTHENTICATION_FAILED` refusal rather than
  merely "not established", which would also pass if the connection had simply broken.
- The test needs Node and the built CLI. When either is absent it reports itself as **skipped**
  rather than passing: a green build must not imply an integration that never ran. Both cases
  executed for real in this increment.

### Registration, workspace model, and readiness

- `WorkspaceModel` consumes a `ProjectSnapshot` rather than an IntelliJ `Project`, so the mapping
  rules are exercised without the platform and the platform-facing code stays thin (AGENTS.md §3).
  Root identifiers stay stable while their URI is unchanged, and the epoch advances only when the
  root set actually changes or semantic state is explicitly invalidated — bumping it needlessly
  would revoke every live handle. A root that leaves and returns gets a new identifier, because
  anything held against the old one is no longer valid.
- A project whose trust the IDE cannot determine is reported `untrusted`. Writes must fail closed,
  never on an optimistic reading.
- `ReadinessModel` is where readiness becomes observable rather than assumed. VS Code exposes no
  index signal, so its adapter never reports `indexing` and never emits `INDEX_NOT_READY`
  (ADR-0019); JetBrains has dumb mode, so both are truthful here. Index-dependent operations are
  named in `capabilitiesUnavailable` rather than answered with empty results, which would read as
  "no matches" instead of "cannot answer yet". `document/read` and `document/getRevision` are
  deliberately absent from that list: they need the document, not the index, and remain available.
- Progress is reported as unknown rather than invented, because the platform usually shows an
  indeterminate indicator rather than a percentage.
- `AdapterRegistration` rebuilds its parameters from current state on every call and verifies the
  response: a daemon that echoed a different adapter identity, or workspaces this adapter does not
  own, is not one to keep talking to. Operations not yet implemented are announced as
  `unavailable` **with a reason** rather than omitted, so a consumer sees a truthful refusal instead
  of an unexplained absence.
- `RealDaemonRegistrationTest` closes the loop the handshake test opened: the plugin registers a
  workspace with the real daemon and a **separate consumer session** observes it through
  `workspace/list` and `workspace/getStatus`, then the adapter deregisters cleanly.

### The platform boundary

`IntelliJProjectSnapshot` is the only file that reads live IDE state, and it is deliberately small:
content roots, trust, and index state, nothing else. Everything above it works on
`ProjectSnapshot` and `IndexState`, which is what lets the mapping rules be tested without the
platform.

- Content roots are read inside a `ReadAction`. The project model may be mutated from another
  thread, and reading it without one is a race the platform forbids (AGENTS.md §3).
- A root's VFS `url` is passed through unchanged rather than converted to a local path, which the
  protocol forbids (AGENTS.md §2).
- ~~Trust comes from `TrustedProjects.getProjectTrustedState`, which answers `ThreeState`.~~
  **Superseded on 2026-08-02 by [ADR-0026](0026-jetbrains-plugin-must-not-bundle-platform-runtimes.md).**
  The Plugin Verifier showed that every `getProjectTrustedState` overload is `@ApiStatus.Internal`
  and that the only public reader is the boolean `isProjectTrusted`. The adapter uses the public
  one, so this adapter no longer distinguishes an undecided project from a denied one. Only
  `trusted` permits writes, so it still fails closed, but the fidelity claimed above is not what
  ships.
- Index state comes from `DumbService.isDumb`, plus `Project.isInitialized` for a project that is
  still opening.

~~**This file is compile-checked against the real IntelliJ platform but not unit-tested**: exercising
it needs a live `Project`, which only a sandboxed IDE run provides. That is 4h.~~
**No longer true as of 2026-08-02.** IntelliJ platform test fixtures supply a real in-memory
`Project` headlessly, so `IntelliJProjectSnapshotTest` exercises this file directly — see
[ADR-0026](0026-jetbrains-plugin-must-not-bundle-platform-runtimes.md), which also explains why this
was not possible before: a bundled Kotlin runtime was killing indexing inside the fixture.

## Alternatives considered

### Generate Kotlin from the schemas

Rejected for this increment, not on principle. It would make drift impossible by construction, and
it remains the right answer if a third adapter language appears. For one consumer, the conformance
suite gives most of the guarantee at a fraction of the cost.

### Implement only the types the current increment needs

Rejected. No test could then assert catalogue completeness, and the true state of protocol coverage
would be unknowable — which is precisely what the phase status is supposed to report.

### Keep `symbol/getImplementations` divergent and special-case the code

Rejected. The divergence has no stated rationale, and every adapter would have to reproduce it.
