# ADR-0025 — One rule, two languages: shared behavioural vectors

## Status

Accepted — 2026-08-02

## Context

Workspace URI containment decides whether an adapter may report a document at all. The daemon
enforces it on every routed result and closes the adapter session with a policy violation when a URI
falls outside every registered root.

For the VS Code adapter this was solved by construction: ADR-0017 moved `isUriWithinWorkspaceRoot`
into `@ide-bridge/protocol`, so the daemon and the adapter execute the same function. The JetBrains
adapter cannot share that code — it is Kotlin — so the rule now exists twice.

Two implementations of a security rule that must agree exactly is the same drift risk the protocol
types face, and the same answer applies: do not ask people to keep them in step, make a test fail
when they are not.

## Decision

- `packages/protocol/fixtures/vectors/uri-containment-vectors.json` holds the vectors, each with the
  reason it is what it is. The TypeScript daemon test and the Kotlin adapter test are both driven by
  that file rather than by cases restated in either language.
- Both tests additionally assert that the vector set exercises both outcomes, so a file that lost
  all its negative cases could not pass unnoticed.
- The vectors cover what actually goes wrong: a sibling sharing a name prefix, dot and dot-dot
  segments, percent-encoded traversal, a percent-encoded separator, a differing authority, scheme,
  query, or fragment, an unparseable root, and an empty URI. A NUL byte in a decoded path is
  checked in the Kotlin suite as well, since percent-encoded NUL is a classic truncation trick.
- Neither implementation converts a URI to a filesystem path. Percent-encoding and dot segments are
  normalized for authorization only; the original URI is what travels on the wire (AGENTS.md §2).

## Applied again: controlled relocation

The same problem appeared immediately with relocation. ADR-0018 defines it as a behaviour — one
match resolves, none fails closed with `STALE_SYMBOL`, several report every candidate with
`AMBIGUOUS_SYMBOL`, and the selection range breaks a tie only when exactly one candidate still
carries it. Two adapters implementing that separately would let the same protocol answer differently
depending on which IDE a consumer happens to be attached to.

`symbol-relocation-vectors.json` holds those cases and both suites are driven by it. Each asserts
the set exercises all three outcomes, so a vector file that lost its ambiguous cases could not pass.
Three mutations of the Kotlin rule — matching the fingerprint as ADR-0003 literally says, dropping
the container comparison, and picking the first candidate instead of reporting ambiguity — are each
caught by the shared vectors.

## Consequences

- A change to a rule in one language fails the other's build until both agree.
- Adding a case means adding it once, and both adapters are held to it.
- The vectors are a contract in their own right. Removing one to make a build pass is visible in the
  file, not buried in a language-specific test.
- This is the pattern for any behaviour a second adapter must reproduce. It is cheaper than a shared
  implementation where none is possible, and unlike a convention it fails loudly.

## Alternatives considered

### Restate the cases in each language

Rejected. That is what existed, and it is precisely the arrangement in which two implementations
quietly stop agreeing.

### Have the Kotlin adapter ask the daemon whether a URI is contained

Rejected. It would put a network round trip inside a check performed per document, and the adapter
must be able to refuse a URI before it ever builds a result to send.
