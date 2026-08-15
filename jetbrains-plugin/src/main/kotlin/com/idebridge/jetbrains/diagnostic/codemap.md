# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/diagnostic/

## Responsibility

Maps IntelliJ highlight objects to IDEBP protocol `Diagnostic` DTOs. Free of platform types — the platform-facing layer (`IntelliJDiagnostics` in `platform/`) only describes each highlight as a `Highlight`, and this module does the severity mapping, offset-to-range conversion, fix extraction, and redaction. One file: `DiagnosticMapping`. The mapping is exercised without an IDE, and the platform boundary is the sole place that touches `HighlightInfo` (ADR-0027).

## Design Patterns

- **Platform-free mapping (anti-corruption)** — `DiagnosticMapping` is a pure-Kotlin `object` that consumes `Highlight` (a platform-free interface) and produces `Diagnostic` (a protocol DTO). The platform file `IntelliJDiagnostics` is the sole place that constructs `Highlight` instances from `DaemonCodeAnalyzerImpl.getHighlights` (internal API, ADR-0027) (DiagnosticMapping.kt:39-57).
- **Threshold-based severity mapping** — IntelliJ severities are an open numeric scale (plugins register their own), so severity is classified by threshold rather than by name. ERROR ≥ 400, WARNING ≥ 300, HINT ≥ 200, INFORMATION below (DiagnosticMapping.kt:34-36, 143-149).
- **Drop-not-truncate for messages** — A message longer than `MAX_MESSAGE_LENGTH` (2048) is dropped entirely rather than cut, because truncating would change what the language service said while presenting it as the service's own message (DiagnosticMapping.kt:27, 123).
- **Redaction by omission** — The tooltip is never read (it routinely embeds source text), and only the short description travels. An empty fix list is omitted rather than sent empty, because an empty list would claim the IDE offered nothing — a different statement from "this highlight carries no offers" (DiagnosticMapping.kt:44-45, 136-138).
- **Truncated flag is honest** — `truncated` is set when entries are dropped past `MAX_DIAGNOSTICS_PER_DOCUMENT` or when an entry cannot be represented, but not when entries were below the severity floor (that is a scope decision made by the caller, not a missing result) (DiagnosticMapping.kt:86-89, 99-112).
- **Analysis state travels with the result** — `Analysis` enum (`COMPLETED`, `PENDING`, `UNAVAILABLE`) prevents an empty list from being mistaken for "clean" when the IDE has not finished analysing the document (DiagnosticMapping.kt:71-80, 99).

## Key Types

- `DiagnosticMapping` (object, `DiagnosticMapping.kt:19`) — Stateless mapper. All functions are pure; no platform types.
  - `MAX_DIAGNOSTICS_PER_DOCUMENT = 1_000` (line 21) — mirrors `IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT` in the protocol package.
  - `MAX_MESSAGE_LENGTH = 2_048` (line 27) — messages above this are dropped, not truncated.
  - `ERROR_LEVEL = 400`, `WARNING_LEVEL = 300`, `WEAK_WARNING_LEVEL = 200` (lines 34-36) — severity thresholds.
- `Highlight` (interface, `:39-57`) — One highlight as the platform reports it: `severityLevel: Int`, `startOffset: Int`, `endOffset: Int`, `message: String?` (short description only, never the tooltip), `source: String?` (inspection id), `fixes: List<Fix>`.
- `Fix` (data class, `:60`) — One offered fix: `fixId: String`, `title: String`. Opaque handle and the IDE's own wording, never interpreted here.
- `Mapping` (data class, `:62`) — Result of `map()`: `diagnostics: List<Diagnostic>`, `truncated: Boolean`.
- `Analysis` (enum, `:71-80`) — How much the IDE has analysed: `COMPLETED` (empty list means clean), `PENDING` (not yet run or still running: absent problems prove nothing), `UNAVAILABLE` (the IDE does not highlight this document at all).

## Key Functions

- `map(highlights: List<Highlight>, index: LineIndex, analysis: Analysis): Mapping` (`DiagnosticMapping.kt:90-114`) — Maps a document's highlights to protocol diagnostics. Sets `truncated = true` when `analysis == PENDING`, when the count exceeds `MAX_DIAGNOSTICS_PER_DOCUMENT`, or when a highlight cannot be represented (null from the private `map(highlight, index)`).
- `map(highlight: Highlight, index: LineIndex): Diagnostic?` (`:117-141`, private) — Maps a single highlight. Returns `null` (counted as missing, sets `truncated`) when offsets are stale (not covered by `index.covers`), when the message is blank or too long, or when the highlight otherwise cannot be represented. Sets `code = null` (the platform has no diagnostic code; inventing one from the inspection id would present an internal identifier as a language-service-assigned code). Omits `availableFixes` when empty rather than sending an empty list. Sets `relatedInformation = null`.
- `severity(level: Int): DiagnosticSeverity` (`:143-149`) — Threshold mapping: ≥ 400 → `ERROR`, ≥ 300 → `WARNING`, ≥ 200 → `HINT` (weak warnings are IntelliJ's faint suggestion, which is what `HINT` means here), else `INFORMATION`.

## Data & Control Flow

```
Platform highlights (IntelliJDiagnostics.highlights → List<Highlight>)
   │
   ├─ DiagnosticMapping.map(highlights, index, analysis)
   │    ├─ analysis == PENDING?  ──► truncated = true (empty list is not "clean")
   │    ├─ for each highlight:
   │    │    ├─ index.covers(start, end)?  ── no  ──► null (stale offsets, document changed)
   │    │    ├─ message blank or > 2048?   ── yes ──► null (dropped, not truncated)
   │    │    └─ Diagnostic(range, UTF16, severity(level), message, source, fixes)
   │    ├─ count >= 1000?  ──► truncated = true, stop
   │    └─ Mapping(diagnostics, truncated)
   │
   └─ analysis state (DaemonAnalysisTracker.state → COMPLETED | PENDING | UNAVAILABLE)
        └─ UNAVAILABLE ──► empty list is the complete truth (nothing to wait for)
```

The `LineIndex` (from `document/`) converts character offsets to UTF-16 line/character positions. The `Analysis` state comes from `DaemonAnalysisTracker` (in `platform/`), which subscribes to `DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC`.

## Integration Points

- **Consumed by**: `com.idebridge.jetbrains.service.AdapterBackend` — calls `DiagnosticMapping.map()` inside a `ReadAction` to build `DiagnosticsGetSnapshotResult` (AdapterBackend.kt:295-299).
- **Depends on**: `com.idebridge.jetbrains.protocol` — `Diagnostic`, `DiagnosticSeverity`, `AvailableFix`, `PositionEncoding`. `com.idebridge.jetbrains.document.LineIndex` — offset-to-range conversion. `com.idebridge.jetbrains.platform.DaemonAnalysisTracker` — supplies `Analysis` state (via the caller).
- **External boundaries**: The `Highlight` interface is the seam. `IntelliJDiagnostics` (platform/) constructs `PlatformHighlight` instances from `DaemonCodeAnalyzerImpl.getHighlights` (internal API, ADR-0027) and passes them here. No `HighlightInfo` or platform type crosses this boundary.

## Common Gotchas

- **The tooltip is never read** — `Highlight.message` is the short description only. The tooltip (`getToolTip()`) routinely embeds the offending source text and must not leave the IDE (DiagnosticMapping.kt:44-45). `IntelliJDiagnostics` respects this: it reads `it.description`, never `getToolTip()`.
- **Dropped, not truncated** — A message over `MAX_MESSAGE_LENGTH` (2048) is dropped (returns `null`), not cut. Truncating would change what the language service said while presenting it as the service's message (DiagnosticMapping.kt:27, 123).
- **`truncated` is not set for below-floor severities** — A highlight below the caller's severity floor is a scope decision, not a missing result. Conflating them would make every clean document look incomplete (DiagnosticMapping.kt:86-89).
- **`code` is always `null`** — The platform has no diagnostic code, and inventing one from the inspection id would present an internal identifier as if a language service had assigned it (DiagnosticMapping.kt:131-133).
- **`availableFixes` is omitted when empty** — An empty list would claim "the IDE offers nothing here", which is a different statement from "this highlight carries no offers to report" (DiagnosticMapping.kt:136-138).
- **`relatedInformation` is always `null`** — IntelliJ highlights carry related information as separate `HighlightInfo` entries, not as nested data; the adapter does not reconstruct the relationship (DiagnosticMapping.kt:139).
- **Weak warning maps to `HINT`** — IntelliJ's `WEAK_WARNING` (level 200) is a faint suggestion, which is what `HINT` means in IDEBP, not `WARNING` (DiagnosticMapping.kt:146-147).
- **`Analysis.PENDING` forces `truncated = true`** — An empty list from an unfinished analysis is not "clean"; the result must say so (DiagnosticMapping.kt:99).
