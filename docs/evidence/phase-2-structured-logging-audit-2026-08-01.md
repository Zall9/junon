# Phase 2 structured logging audit — 2026-08-01

## Verdict

**ACCEPT after remediation.** The daemon now exposes structured lifecycle and authenticated-dispatch
records through a deny-by-default boundary. Client-controlled identifiers are pseudonymized before
serialization, and protocol payloads or raw errors cannot be passed to the sink API.

This does not complete Phase 2. CLI/doctor, Windows discovery ACLs, process-supervision tests, and
real IDE adapter integration remain pending.

## Boundary audited

- TASK observability fields and security exclusions.
- Authentication, handshake, session, RPC, heartbeat, shutdown, and error paths.
- Client-controlled request identifiers and generated session identifiers.
- Source, replacement, URI, diagnostic, provider-error, and topology exposure.
- Wall-clock versus monotonic duration behavior.
- Log-level configuration, record size, event rate, and sink failure behavior.
- Protocol-package independence and future CLI ownership.

## Findings and remediation

| ID | Severity | Finding | Remediation |
|----|----------|---------|-------------|
| LOG-01 | Critical | A generic context logger could accept complete requests, provider errors, source, replacements, or diagnostics. | ADR-0011 and `StructuredLogger` expose event-specific methods and construct only explicit fields. |
| LOG-02 | Critical | Raw JSON-RPC IDs are peer-controlled and can themselves contain the authentication token or source text. | Every request ID is replaced by a process-local HMAC-SHA-256 correlation value before serialization. |
| LOG-03 | High | Error messages and stacks can contain provider data or paths even when truncated. | No raw `Error`, message, stack, validation detail, URI, or payload is accepted by the sink boundary. |
| LOG-04 | High | Logging could change handshake/request behavior if a clock, serializer, or sink throws. | All observational failures are locally contained and never recursively logged. |
| LOG-05 | High | Unbounded per-message logs could amplify a local notification flood. | A configurable hard-bounded fixed window limits emission and summarizes dropped records with bounded state. |
| LOG-06 | Medium | Wall-clock changes could create invalid durations. | UTC wall time is used only for timestamps; durations use a monotonic clock and are clamped non-negative. |
| LOG-07 | Medium | Logging client names, topology, workspaces, or URIs would add unnecessary identifying data. | Session records include only the daemon-generated session ID and role; event/method/reason values are canonical enums. |
| LOG-08 | Medium | Library-level default stderr output would surprise embedders and flood existing tests. | The composed daemon defaults to a silent logger; the future CLI explicitly owns sink and level selection. |

## Verification

Focused coverage includes:

- exact allowlisted JSON record shape and monotonic duration;
- stable within-process and unlinkable cross-key request correlation;
- real authentication token used as a valid RPC request ID without appearing in logs;
- source-, replacement-, diagnostic-, and provider-error-shaped secrets absent from output;
- invalid runtime enums and fields ignored rather than serialized;
- rate-limit drop summary and bounded counter behavior;
- log-level filtering plus throwing clock/sink containment;
- composed daemon start, session open/close, RPC dispatch, and stop events.

## Validation results

Validated locally with Node 24.15.0 and pnpm 10.32.1:

- frozen install: pass;
- Prettier format check and ESLint: pass;
- strict TypeScript typecheck across five packages plus scripts: pass;
- all five TypeScript package builds: pass;
- complete Vitest suite: 27 files / 181 tests;
- bridge-daemon: 9 files / 67 tests;
- bridge-client: 7 files / 42 tests;
- protocol: 9 files / 70 tests;
- protocol runtime catalogue and fixtures: 161 compiled schema entries / 35 fixtures;
- generated protocol type freshness: pass;
- deterministic TypeScript fixture typecheck, Java fixture compilation, and PHP fixture lint: pass.

## Next audit boundary

Before CLI/doctor implementation, audit process ownership, discovery-file lifecycle and rotation,
single-instance behavior, signal/shutdown handling, command output versus log output, health-check
authority, endpoint/token exposure, exit-code stability, and daemon supervision tests.
