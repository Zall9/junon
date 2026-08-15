# Suggested commands

## TypeScript workspace

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm -r build
pnpm protocol:fixtures
pnpm protocol:generate:check
pnpm cli:smoke
```

- Force the CI runtime locally with Node 24, e.g. `nvm use 24`; on this machine the validated binary directory is `/Users/pauldelifer/.nvm/versions/node/v24.15.0/bin`.
- Package tests:
  - `pnpm --filter @ide-bridge/protocol test`
  - `pnpm --filter @ide-bridge/bridge-daemon test`
  - `pnpm --filter @ide-bridge/bridge-client test`
  - `pnpm --filter @ide-bridge/cli test`
  - `pnpm --filter vscode-extension test`
  - `pnpm --filter @ide-bridge/conformance test`

## Deterministic fixtures

```bash
pnpm exec tsc --noEmit --project examples/typescript-project/tsconfig.json
javac -d <temp-dir> examples/java-project/src/main/java/idebridge/examples/*.java
php -l examples/php-project/src/Domain/User.php
php -l examples/php-project/src/Domain/UserRepository.php
php -l examples/php-project/src/Support/User.php
php -l examples/php-project/tests/UserTest.php
```

## JetBrains / Python

```bash
cd jetbrains-plugin && ./gradlew test && ./gradlew buildPlugin
cd integrations/serena && python3 -m pytest
```

- JetBrains local Gradle needs `JAVA_HOME` pointing to IntelliJ's bundled JBR.
- Use `rg` / `rg --files` for repository search.
- Run `serena memories check` from project root after memory graph changes.