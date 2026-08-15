# packages/bridge-daemon/

## Responsibility

The one stateful party. It authenticates both roles on loopback, keeps the registry of adapters and
workspaces, routes every consumer request to the adapter that can answer it, owns edit plans and undo
tokens, and refuses anything that would let one side see another's private identifiers.

## Design

**Adapters and consumers never meet.** Every routed request is rewritten on the way through: a plan a
consumer holds carries a daemon-issued id, not the adapter's. `plan/in-memory-edit-store.ts` is where
that translation and its lifetime live.

**A refusal names its rule.** Rejecting an adapter's response closes its session — a contract
violation, not an ordinary failure — and the close reason is the only channel that reaches the
adapter's author. So the store's refusals carry a reason, and compound checks are split so that "one
of three things" is never the answer
([ADR-0038](../../docs/adr/0038-the-party-that-applies-a-plan-checks-it.md)).

**An answer that cannot distinguish two situations says which.** `STALE_DOCUMENT` carries the
document's current revision rather than being flattened into `PLAN_NOT_FOUND`; `document/changed`
invalidates plans _with_ that revision so the refusal is actionable.

**Loopback only, token always.** `security/` and `transport/` enforce that together: the server binds
`127.0.0.1`/`::1`, the discovery file is `0600`, and a handshake without a valid token gets a generic
refusal.

## Flow

```
transport/    loopback WebSocket, frame ceiling, close-reason clamp (123 bytes)
   │
session/      handshake → role, protocol version, registry of adapters + workspaces + trust
   │
routing/      application-router.ts — the single place a request becomes an answer:
   │            consumer-local  → answered here (workspace/list, workspace/getStatus, bridge/*)
   │            routed          → forwarded to the owning adapter, response transformed back
   │            notifications   → applied to the registry and the plan store, then broadcast
   │
plan/         plans and undo tokens: created on prepare, consumed once, invalidated by document,
              workspace, epoch or session; remembers briefly *why* a plan went away
   │
observability/ structured logs that never carry content, and refusal/incompleteness counters
dashboard/     read-only local surface (ADR-0035); serves no protocol methods
```

`workspace/getStatus` is answered **here**, from the adapter's last `workspace/readinessChanged` — the
request never reaches the IDE, which is why an adapter must announce rather than be asked
([ADR-0039](../../docs/adr/0039-readiness-is-watched-not-remembered.md)).

## Integration

Started by `packages/cli` or spawned by the VS Code extension, which bundles it. Both adapters and
every consumer reach it through `bridge-client`.
