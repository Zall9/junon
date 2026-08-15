# Phase 2 plan store audit — 2026-08-01

## Verdict

**ACCEPT after remediation for this increment.** The daemon now intercepts
`refactor/prepareRename`, `workspace/applyPlan`, `workspace/discardPlan`, and `workspace/undo`
instead of forwarding consumer authorization handles directly. Plans and undo tokens have separate
daemon-owned public identities and adapter-owned private identities, are scoped to both sessions and
one workspace, and are consumed once.

This is not a Phase 2 completion verdict. Live revision/content verification remains an adapter
responsibility in Phases 3 and 4 in addition to daemon-side epoch and event invalidation. Shared
client inbound request dispatch, reconnection, heartbeat/session expiration, structured logging,
and the CLI/doctor remain pending.

## Audited boundary

- ADR-0004 lifecycle semantics and its interaction with session authority in ADR-0006
- public consumer ownership versus private adapter ownership
- expiry, workspace epoch, document events, disconnects, and root changes
- concurrent apply/discard/undo, cancellation, timeout, and lost-response outcomes
- internal and public ID collisions and resource limits
- advertised capability and workspace-trust gates
- successful and `PARTIAL_APPLY` result validation and error-detail rewriting
- URI containment without converting wire URIs to local paths
- interaction with Serena-generated `codemap.md` files and the root Vitest project glob

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P2-PLAN-AUD-01 | Critical | ADR-0004 said a plan belonged to one session, but an adapter creates it and a consumer authorizes its use. Exposing adapter IDs would permit collisions and would not bind authority to the requesting consumer. | Added ADR-0007. The daemon stores private adapter and public consumer representations, generates random public IDs, and rewrites only at the trusted routing boundary. ADR-0004 and ADR-0006 now link to the amendment. |
| P2-PLAN-AUD-02 | Critical | Reusing a public plan or undo token after timeout or a lost response could repeat a write whose outcome is unknown. | Apply, discard, and undo remove public authority before forwarding and never reactivate it. Concurrent calls have one winner. Internal identities remain reserved until the routed operation settles. |
| P2-PLAN-AUD-03 | Critical | Plan preconditions and changed URIs could name resources outside registered workspace roots. | Added URI-only containment checks with normalized percent-encoded separators and dot segments, exact scheme/authority/query/fragment matching, and segment-boundary comparison. Original URI strings are preserved and no local path conversion occurs. |
| P2-PLAN-AUD-04 | High | Successful or partial adapter results could report unplanned, duplicate, cross-workspace, wrong-root, stale-epoch, or hash-inconsistent documents; error details could leak private plan IDs. | Success requires the exact prepared URI set; partial apply allows only a valid subset. Document version, epoch, root, before/after hash, and revision-hash invariants are checked. Diagnostics are workspace checked. Error details are validated and private plan IDs are rewritten. Invalid provider results close only that adapter. |
| P2-PLAN-AUD-05 | High | Undo is a write and was not protected by workspace trust. Workspace/root invalidation also left public undo authority alive. | Apply and undo both require `trust: trusted`; workspace invalidation removes plans and undo tokens. Session removal invalidates both representations. |
| P2-PLAN-AUD-06 | High | Internal plan or undo IDs could collide while an earlier operation using the same private ID was still in flight. | Per-adapter-session internal identities are unique and remain reserved through response, cancellation grace, timeout, send failure, or disconnect cleanup. Exceptional pre-route paths release reservations safely. |
| P2-PLAN-AUD-07 | High | The router could send a method the adapter had not advertised, contrary to explicit capability negotiation. | New read/prepare work is routed only when the workspace owner advertises an available capability. Existing plan cleanup and one-shot authorization operations remain bound to the adapter that issued them. |
| P2-PLAN-AUD-08 | Medium | Undo-token comparison used serialized property order and adapter-provided tokens without an expiry could persist for the session lifetime. | Tokens are compared field by field and every public token receives a daemon-bounded expiration, even when the private adapter token omits one. |
| P2-PLAN-AUD-09 | Medium | Serena added `packages/codemap.md`; the root Vitest glob `packages/*` then treated it as a project configuration and broke the complete suite. | The project glob now targets `packages/*/vitest.config.ts` explicitly. |

No unresolved correctness finding remains inside this increment's declared daemon-side boundary.

## Verified behavior

- adapter plan identity is never exposed to the consumer
- public plan identity and session are never forwarded to the adapter
- apply, discard, and undo are one-shot and replay returns `PLAN_NOT_FOUND`
- expiration is capped by daemon policy; workspace epoch mismatch returns `PLAN_EXPIRED`
- document, workspace, and session invalidation removes relevant authorization
- duplicate public and private IDs fail closed
- untrusted workspaces reject apply and undo
- absent/unavailable capabilities do not reach an adapter
- successful apply returns exactly the prepared document set and a rebound undo token
- invalid apply documents produce `PROVIDER_FAILED` and close the offending adapter
- unsafe URI traversal, sibling roots, schemes, authorities, and query identities are rejected
- store and in-flight route counts are bounded and cleanup timers do not keep the process alive

## Node 24.15.0 evidence

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm -r build                     # 5 packages
pnpm typecheck
pnpm test                         # 24 files, 151 tests
pnpm protocol:fixtures            # 161 entries, 35 fixtures
pnpm protocol:generate:check
```

Daemon package: 8 files / 54 tests, including real loopback WebSocket plan lifecycle and invalid
provider-result integration. The hosted GitHub Actions run and real IDE adapter paths remain
unverified.

## Next audited boundary

The shared TypeScript client needs authenticated inbound request dispatch for adapter sessions,
including request cancellation and bounded handler execution. That boundary is required before the
VS Code adapter can use the shared client and before Serena can exercise a real adapter rather than
the raw integration peer used here.
