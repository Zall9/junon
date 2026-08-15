# IDE Bridge

A protocol and daemon that lets AI agents communicate with VS Code and JetBrains IDEs through a unified, IDE-independent, language-independent, versioned, capability-oriented, revision-aware protocol over loopback WebSocket.

## Status

[docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) is the summary of where this stands: architecture,
what works, what is only wired, every validation command with its real result, and the remaining
risks stated at full strength. [docs/STATUS.md](docs/STATUS.md) records what is verified, what is
not, and what is deliberately deferred — read it before relying on anything below. In short: both adapters run in real IDEs. The
JetBrains one has been **run** in IntelliJ, PhpStorm, GoLand and PyCharm — not merely measured
compatible — and serves all 16 routed methods. The VS Code one serves 13; the three it does not are
refusals with reasons, not gaps.

## Architecture

```
Agent IA / MCP client
        │
        ▼
Serena or other integration
        │
        │ IDE Bridge Protocol (IDEBP)
        ▼
IDE Bridge Daemon
        │
        ├── VS Code Adapter
        │       └── VS Code native APIs and installed providers
        │
        └── JetBrains Adapter
                └── PSI, indexes, and native refactoring APIs
```

## Monorepo Structure

```
ide-bridge/
├── packages/
│   ├── protocol/          # JSON Schema 2020-12 wire contracts and TypeScript types
│   ├── bridge-daemon/     # WebSocket JSON-RPC 2.0 server (loopback only)
│   ├── bridge-client/     # Shared TypeScript client (discovery, auth, typed RPC)
│   ├── vscode-extension/  # VS Code adapter
│   └── conformance/      # IDE-independent conformance suite
├── jetbrains-plugin/     # JetBrains IntelliJ Platform adapter (Kotlin)
├── integrations/
│   └── serena/           # Serena Python backend
├── examples/             # Deterministic example projects
└── scripts/              # Protocol and conformance scripts
```

## Prerequisites

- **Node.js** 24 LTS
- **pnpm** 10.x
- **Python** >= 3.12 (for Serena integration)
- **JDK 21+** and **Gradle** >= 9.0 (for JetBrains plugin)

## Getting Started

```bash
# Install dependencies
pnpm install

# Run all checks
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test

# Run a single package's tests
pnpm --filter @ide-bridge/protocol test
```

## Validation Commands

| Command | Description |
|---------|-------------|
| `pnpm format:check` | Prettier format check |
| `pnpm format` | Prettier format (write) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript strict mode type check |
| `pnpm test` | Vitest (all packages) |

## Protocol

The IDE Bridge Protocol uses JSON Schema 2020-12 as the canonical wire-contract definition. TypeScript types are generated from schemas, not the reverse. Runtime validation uses [Ajv](https://ajv.js.org/) 2020-12 via `ajv/dist/2020.js`.

The protocol package (`@ide-bridge/protocol`) is strictly independent of VS Code, JetBrains, and Serena. This is enforced by an ESLint `no-restricted-imports` rule.

## License

Apache-2.0. See [LICENSE](./LICENSE).
