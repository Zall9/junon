# Task completion gates

A feature/increment is complete only after:

1. Audit relevant schemas, ADRs, package boundaries, authority model, cancellation/races, limits, and existing tests.
2. Implement with truthful capability/error semantics.
3. Add unit tests plus proportional real integration coverage.
4. Run under Node 24:
   - frozen install;
   - `pnpm format:check`;
   - `pnpm lint`;
   - `pnpm typecheck`;
   - targeted package tests;
   - `pnpm test`;
   - `pnpm -r build`;
   - protocol fixtures and generated-type freshness;
   - CLI/bundle smoke where affected;
   - TypeScript/Java/PHP deterministic fixtures where protocol/adapter behavior is affected.
5. Fix failures; rerun the failed gate and any dependent gates. Never declare complete from typecheck alone.
6. Update `docs/IMPLEMENTATION_PLAN.md` phase paragraph and append an exact dated log entry.
7. Add/update ADR for protocol, compatibility, security, transport, transaction, symbol, or edit decisions.
8. Add a dated `docs/evidence/` audit file with scope, findings, remediation, exact test/build counts, limitations, and next audit boundary.
9. Update architecture/security docs and affected codemaps; remove stale claims.
10. Final `pnpm format:check` and documentation consistency search.
11. Report exact changes, validation evidence, remaining work, and confirm no commit/remote mutation.

Display-dependent checks remain explicit gaps until actually run: VS Code `@vscode/test-electron`, VSIX inspection, JetBrains `runIde`.