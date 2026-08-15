# Phase 1 protocol audit — 2026-08-01

## Verdict

**ACCEPT after remediation.** Phase 1 satisfies its implementation and local runtime acceptance
criteria. The complete validation chain passes on the target runtime, Node 24.15.0. Phase 2 may
start. Execution of the workflows on GitHub-hosted runners remains an operational risk to verify,
but it is no longer a missing local Node 24 validation.

## Scope

- `TASK.md` §§7–15 and §23
- ADRs 0001–0004 and the resulting wire contracts
- all schemas, generated TypeScript declarations, fixtures, and protocol tests
- protocol/IDE/Serena independence
- package exposure required for Phase 2 runtime validation
- GitHub Actions ordering and applicability

## Findings and remediation

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| P1-AUD-01 | High | `setup-node` requested pnpm caching before pnpm was installed. | Added `pnpm/action-setup@v4` before `actions/setup-node`; removed the later Corepack step. This follows the official `setup-node` pnpm caching sequence. |
| P1-AUD-02 | High | The capability schema required `guarantee` for every available capability, rejecting the canonical atomicity-only apply capability. | Made capability dimensions operation-dependent, added a compatibility fixture/type test, and recorded the decision in ADR-0005. |
| P1-AUD-03 | High | Required normalized-error semantics were not encoded: `INDEX_NOT_READY` could be non-retryable and structured details were optional for stale, ambiguous, and partial-apply errors. | Replaced generic permissiveness with discriminated error-data variants and added four negative fixtures. |
| P1-AUD-04 | Medium | Testing-only language expectation metadata lived under the canonical wire-schema directory. | Moved it to `fixtures/schemas`; generation now reads only the 29 wire-schema documents. |
| P1-AUD-05 | Medium | The protocol package did not expose its canonical schemas for Phase 2 runtime validation. | Added package `files` and `./schemas/*` exports plus an automated package-contract test. |
| P1-AUD-06 | Medium | The TypeScript workflow typechecked and tested but did not execute package builds. | Added `pnpm -r build` and explicit read-only workflow permissions. |

No unresolved Phase 1 correctness finding remains. The contract remains version `0.1.0` because it
has not been released and Phase 1 was not complete before this audit.

## Acceptance evidence

| Criterion | Evidence |
|-----------|----------|
| Complete public catalogue | 24 request/response pairs, 14 notifications, 22 normalized errors; exact catalog tests pass |
| Schema validity | Ajv 2020-12 strict mode compiles 159 wire and fixture-support entries |
| Valid/invalid fixtures | 29 manifest fixtures pass their expected validity |
| Serialization | all 64 public message forms round-trip; all 22 error codes serialize |
| Generated types | 138 exports; generated freshness check passes |
| URI and positions | non-local URI preservation and explicit position encoding tests pass |
| Revision/edit invariants | complete revisions, bound edit plans, stale details, and partial-apply details enforced |
| Language fixtures | TypeScript typecheck, Java main compilation, PHP lint, and expected source-range checks pass |
| Independence | root lint enforces forbidden-import boundaries; no IDE SDK or Serena imports occur in protocol source |
| Target runtime | complete chain passes under Node 24.15.0 with pnpm 10.32.1 |

## Commands executed under Node 24.15.0

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test                         # 10 files, 54 tests
pnpm -r build                     # 5 packages
pnpm protocol:fixtures            # 159 entries, 29 fixtures
pnpm protocol:generate:check
pnpm exec tsc --noEmit --project examples/typescript-project/tsconfig.json
```

Additional host checks:

```text
javac ...                         # deterministic Java main sources pass
php -l ...                        # all four PHP fixture files pass
Ruby YAML parse                   # all three workflow files parse
```

## Residual operational risks

- The updated GitHub Actions workflows have not yet run on a real hosted runner.
- VS Code extension-host and JetBrains `runIde` GUI tests remain assigned to their later phases.
- Serena MCP is configured, but its Python analyzer still needs `uv`/`uvx`, and the Kotlin analyzer
  requires permissions outside the workspace sandbox.
