# Tech stack

- Darwin workspace; shell is zsh.
- Node runtime floor: 24. Local validated baseline: Node 24.15.0.
- pnpm 10.32.1; seven workspace projects, six TypeScript build/typecheck packages.
- TypeScript 5.9.3 strict mode; ESLint 10.8.0; Prettier 3.9.6; Vitest 4.1.10.
- Protocol: JSON Schema draft 2020-12; Ajv 8.20 via `ajv/dist/2020.js`; `json-schema-to-typescript` 15.0.4.
- Transport: JSON-RPC 2.0 over `ws` 8.21.1 loopback WebSocket.
- VS Code desktop extension: CommonJS autonomous bundles via pinned esbuild 0.28.1; only `vscode` external.
- Node type declarations are pinned to Node 24, never newer than runtime target.
- JetBrains baseline: JBR/JDK 21, Gradle wrapper 9.0, Kotlin 2.1.20, IntelliJ Platform 2025.2.
- Serena integration: Python >=3.12; locally validated with Python 3.14.6.
- Deterministic examples exist for TypeScript, Java, and PHP.
- Package boundaries: protocol must have zero VS Code, JetBrains, or Serena imports; shared client owns discovery/auth/RPC/reconnect; daemon owns routing/session/security; IDE adapters map native objects to IDEBP DTOs.