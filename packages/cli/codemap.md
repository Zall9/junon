# packages/cli/

## Responsibility

Owns the `ide-bridge` executable, foreground daemon process lifecycle, authenticated administration
commands, and read-only doctor checks. It composes `@ide-bridge/bridge-daemon` and
`@ide-bridge/bridge-client`; it does not implement protocol transport or schemas.

## Design

- Separate workspace package avoids a daemon/client dependency cycle.
- `bin.ide-bridge` points to the compiled shebang entry point.
- TypeScript project references order protocol, daemon, and client builds before CLI compilation.
- Vitest includes unit tests plus a real child-process/loopback integration path.

## Flow

1. `bin.ts` passes process arguments and stdout/stderr writers to `runCli`.
2. Arguments and the discovery path are validated without exposing raw failures.
3. `daemon` owns the foreground server and private discovery lifecycle.
4. Query commands connect as short-lived typed consumers.
5. Exit code is set only after cleanup and output are complete.

## Integration

- Root dev dependency exposes `node_modules/.bin/ide-bridge`; `pnpm cli:smoke` verifies wiring.
- The root Vitest project discovers `packages/cli/vitest.config.ts`.
- CI builds all dependencies before the real-process CLI tests.
