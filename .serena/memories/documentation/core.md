# Documentation maintenance

- `docs/IMPLEMENTATION_PLAN.md` is the canonical living phase plan. Update phase summary and append a dated exact log after every validated increment.
- `TASK.md` is immutable product scope.
- `AGENTS.md` is authoritative working policy and validation command source.
- ADRs are append-only decisions. Create/update for protocol, compatibility, security, transaction, transport, symbols, or edit semantics. Supersede with links; never delete.
- Evidence lives under `docs/evidence/`; one dated file per increment with audit scope, findings, fixes, validation counts, remaining limitations, next audit boundary.
- `docs/ARCHITECTURE.md` records component/control-flow guarantees; `docs/SECURITY.md` records trust boundaries and fail-closed behavior.
- Root/package/source `codemap.md` files must track new modules, responsibilities, control flow, integration points, and gotchas.
- Historical evidence files remain historical; do not rewrite old limitations after a later increment closes them.
- Never claim display/host/CI validation from compilation alone. Record Node/runtime/tool versions actually used.
- Before completion search docs/codemaps for stale counts and claims contradicted by the increment.
- Avoid volatile line-number detail in durable memory; use canonical files for current phase status and exact evidence.