# IDE Bridge / moneta

- Purpose: versioned IDE-independent JSON-RPC bridge between AI consumers and VS Code/JetBrains adapters over authenticated loopback WebSocket.
- Product scope is `TASK.md`; never edit it. Agent rules are `AGENTS.md`. Living phase status is `docs/IMPLEMENTATION_PLAN.md`.
- JSON Schema 2020-12 is canonical for every public wire request/response/event/error; generated TypeScript is derivative.
- Audit relevant schemas, ADRs, security boundaries, and existing tests before each implementation increment.
- Never commit, amend, push, publish, release, open PR/MR, or modify remotes. Never modify `.idea/`.
- Keep progress visible: after each meaningful action state what changed, result, and next step.
- For toolchain/version pins and module layout: `mem:tech_stack`.
- For stable project-specific implementation rules: `mem:conventions`.
- For common local commands: `mem:suggested_commands`.
- For required completion gates and evidence: `mem:task_completion`.
- For wire contracts, revisions, handles, cancellation, and prepare/apply: `mem:protocol/core`.
- For authentication, routing, plan ownership, logging, and URI enforcement: `mem:daemon/core`.
- For VS Code lifecycle, document/provider mapping, and handle invalidation: `mem:vscode/core`.
- For ADR/plan/evidence/codemap maintenance: `mem:documentation/core`.
- Do not duplicate volatile phase state in memory; consult the living plan and newest `docs/evidence/` entry.