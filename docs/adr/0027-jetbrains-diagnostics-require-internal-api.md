# ADR-0027: Reading JetBrains diagnostics requires internal platform API

- Status: accepted
- Date: 2026-08-02
- Related: [ADR-0019](0019-diagnostics.md), [ADR-0026](0026-jetbrains-plugin-must-not-bundle-platform-runtimes.md)

## Context

`diagnostics/getSnapshot` answers what a workspace's language services currently report. On VS Code
this is `languages.getDiagnostics`, a documented public API. IntelliJ has no equivalent.

The IDE's diagnostics live in the daemon's highlight model. Every route to a highlight's severity
and message passes through `com.intellij.codeInsight.daemon.impl.HighlightInfo`, which is annotated
`@ApiStatus.Internal` at class level, reached through
`DaemonCodeAnalyzerImpl.getHighlights(Document, HighlightSeverity, Project)`, which the Plugin
Verifier also reports as internal. Reading the markup model instead does not help: a
`RangeHighlighter`'s error-stripe tooltip is that same internal type.

Note that inspecting the class file was not sufficient to establish this — a `javap` reading
suggested `getHighlights` was ordinary public API, and the Plugin Verifier contradicted it. The
verifier is the authority here.

## Decision

The plugin uses the internal API, contained to one file, and enforces that the containment holds.

`IntelliJDiagnostics` is the only file that names either symbol. It converts each highlight into a
`DiagnosticMapping.Highlight` — an interface with no platform types — immediately, so a platform
change touches that file and nothing above it.

The Plugin Verifier's `failureLevel` is all-or-nothing: keeping `INTERNAL_API_USAGES` in it would
fail the build on a dependency that has no alternative, and dropping it would equally hide the
*next* one someone adds. Neither expresses the real constraint. So `INTERNAL_API_USAGES` is dropped
from `failureLevel` and replaced by `checkInternalApiSurface`, which compares what the verifier
reports against `internal-api-baseline.txt`. Every baseline entry carries a reason and an ADR
reference; anything unaccounted for fails the build, naming it. The guard was verified by
reintroducing an unrelated internal call and confirming the build failed with that call named.

## Consequences

**The capability is real rather than approximated.** The alternative considered most seriously was
running inspections through the public `InspectionManager`. It was rejected because it produces a
*different, partial* set — inspection results without annotator or compiler errors — and reporting
that as "the IDE's diagnostics" would be exactly the kind of approximate implementation AGENTS.md §4
forbids. Declaring the capability unavailable was the other option, and it would have understated
what the IDE plainly has.

**The exposure is two symbols and is checked, not asserted.** A future platform that removes or
renames them breaks one file, and the build says so before a user does.

**Redaction is enforced at the boundary.** A highlight's tooltip is HTML that routinely embeds the
offending source text. Only `description` — the short message — is read, and it is length-bounded.
A platform test asserts that a diagnostic message contains neither the offending expression nor
tooltip markup, so the rule is checked against the real daemon rather than trusted.

**A severity floor makes the result a diagnostic set.** The daemon emits an `INFORMATION`-level
highlight for essentially every token, because that is also how syntax colouring is represented.
Highlights are requested at `WEAK_WARNING` and above; without that floor a clean two-line file would
return hundreds of entries that are not problems at all. A test pins this.

**Severity is mapped by threshold, not by name.** IntelliJ's severity scale is open — plugins
register their own — so anchors are used: ≥400 error, ≥300 warning, ≥200 hint (a weak warning is
IntelliJ's faint suggestion, which is what `hint` means), below that information.

**No diagnostic code is emitted.** IntelliJ assigns none. Reusing the inspection id would present an
internal identifier as if a language service had issued it.

**An over-long message is dropped, not cut.** Truncating would change what the language service said
while still presenting it as its message; the entry is instead reported as missing via `truncated`.
