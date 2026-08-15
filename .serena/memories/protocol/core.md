# Protocol invariants

- Canonical wire definitions: `packages/protocol/schemas/`, JSON Schema 2020-12. Runtime catalogue: `packages/protocol/src/application-validation.ts`. Generated types are never hand-edited.
- First WebSocket application message must be authenticated `bridge/handshake`: token method, role, version range, topology. No other dispatch before success.
- Cancellation is exclusively `$/cancelRequest { id }`.
- Runtime validation uses Ajv 2020-12 through `ajv/dist/2020.js`.
- Every document reference carries `editorVersion`, SHA-256 UTF-8 in-memory `contentHash`, and `workspaceEpoch`.
- URI remains original across the wire; containment comparisons are authorization-only normalization.
- Symbol identity has both:
  - opaque temporary handle bound to adapter + physical session + epoch;
  - persistent locator with URI/name/kind/range/fingerprint.
- Name alone is never symbol identity. Do not invent qualified names unavailable from the IDE provider.
- Handles invalidate on relevant document change, epoch advance, disconnect/session expiry. Stale handle requests return `STALE_SYMBOL`; relocation must be controlled and ambiguity explicit.
- All semantic writes use prepare → apply. Plans are daemon-owned public identities mapped to adapter-private identities, bounded, expiring, one-shot, session/workspace/adapter-bound, revision-preconditioned, discardable, and invalidated on changes.
- No direct semantic offset edit and no silent textual fallback.
- Public changes need fixtures/compatibility tests; breaking changes need version decision and ADR.
- Durable decisions: ADR-0001 cancellation/transport, 0002 revisions, 0003 symbols, 0004 edits, 0005 capability dimensions, 0006 routing authority, 0007 plan identities.