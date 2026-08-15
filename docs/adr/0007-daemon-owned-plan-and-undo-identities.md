# ADR-0007 — Daemon-Owned Plan and Undo Identities

## Status

Accepted — 2026-08-01

## Context

An IDE adapter creates the semantic edit preview and therefore returns an `EditPlan` containing an
adapter ID, session ID, plan ID, expiration, and document preconditions. The consumer that requested
the preview must nevertheless be the only session allowed to apply or discard it. Adapter-generated
IDs are scoped to adapter state and cannot be trusted to be globally unique, unpredictable, or safe
to expose as daemon authorization handles.

The same ambiguity applies to undo tokens returned after application. Transport timeout or
cancellation also creates an uncertain outcome: the IDE may have modified documents even when the
daemon did not receive the final response.

## Decision

### Dual identity

The daemon stores two representations:

- the **adapter representation**, containing the adapter's original plan or undo ID and adapter
  session ID;
- the **public representation**, containing a cryptographically random daemon ID and the owning
  consumer session ID.

The public `adapterId` and `workspaceId` remain the exact registered route owner. The daemon rewrites
only the ID, session ID, and any expiration it caps. Consumers never receive the adapter's internal
authorization handle. Adapters receive only their own internal handle on apply, discard, or undo.

### Plan creation checks

Before exposing a prepared plan, the daemon requires:

- exact adapter session, adapter ID, and workspace ownership;
- a future expiration, capped by daemon policy;
- unique precondition URIs and change URIs;
- a document-revision precondition for every changed URI;
- every precondition and changed URI contained by a registered workspace root, checked as a URI
  without converting it to a local path;
- every precondition workspace epoch equal to the current registered workspace epoch;
- no active internal plan with the same adapter session and adapter plan ID.

Failure is treated as `PROVIDER_FAILED`; the untrusted plan is not stored or returned.

### Public authorization

Plan and undo lookup uses the public ID plus exact consumer session and workspace. A mismatch returns
`PLAN_NOT_FOUND` or `PRECONDITION_FAILED` without revealing another session's object. Apply also
requires a currently trusted workspace, the same live adapter session, and the original workspace
epoch. Epoch changes expire all plans for that workspace.

### Atomic transitions

- Apply atomically removes the public plan before forwarding the write request while retaining the
  adapter identity reservation until the routed request settles.
- Once an apply request reaches the adapter, the plan is never made reusable, regardless of success,
  normalized error, cancellation, timeout, disconnect, or lost response. This is stricter than
  reactivating a plan after a non-partial error and avoids replay after an uncertain write outcome.
- Discard atomically removes the public plan before asking the adapter to release its internal plan.
- Undo atomically removes its public token before forwarding while retaining the adapter token
  reservation until settlement. It is one-shot for the same uncertain outcome reason.
- Concurrent apply/discard calls therefore have exactly one winner.

### Result checks

Apply and undo results must contain unique documents in the bound workspace. For a successful apply,
the returned URI set must exactly equal the prepared change set; for `PARTIAL_APPLY`, it must be a
subset. In both cases, `beforeHash` must equal the stored precondition hash and returned document
versions must advance. Each returned `afterHash` must equal its document revision hash, before/after
hashes must differ, and the workspace epoch and root must match the current registry. Post-apply
diagnostics are subject to the same workspace/root/epoch boundary. Error details are checked and
internal plan IDs are rewritten before they reach consumers. Any undo token must match the current
adapter session and workspace before it receives a new public identity.

### Invalidation and cleanup

- `document/changed`, `document/deleted`, and rename events invalidate matching plans.
- workspace epoch/root changes and workspace closure invalidate all workspace plans and undo tokens.
- adapter or consumer session removal invalidates its plans and undo tokens.
- time expiration is enforced on lookup and by an unref'ed periodic sweep.
- store size and per-consumer ownership are bounded.
- if application succeeds while the bounded store has no slot for a returned undo token, the
  successful modification is returned without exposing that private adapter token.

## Consequences

- Adapter IDs cannot collide across sessions at the public API.
- A consumer cannot apply, discard, or undo another consumer's object.
- Timeout and cancellation favor non-replay safety over retrying the same plan.
- Public plan and undo objects differ from the adapter's internal objects only in daemon-owned
  authorization fields and bounded expiration.
- Persistent recovery remains deferred; daemon restart invalidates all public handles.

## Alternatives considered

### Expose adapter IDs unchanged

Rejected because adapters do not provide a global uniqueness or secrecy guarantee.

### Reactivate on timeout or generic error

Rejected because the IDE may already have modified documents when the response is lost.

### Bind only to adapter session

Rejected because any authenticated consumer able to guess a plan ID could apply another consumer's
prepared edit.
