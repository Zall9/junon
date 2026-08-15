# jetbrains-plugin/src/test/kotlin/com/idebridge/jetbrains/

## Responsibility
Unit tests for the IDE Bridge JetBrains plugin Phase 0 skeleton. Validates that service classes instantiate correctly, `ReadinessState` enum covers all five IDEBP states, `ReadinessManager` state transitions and `isIndexReady()` gating work as specified, `BridgeDaemonConnectionService` starts disconnected and handles safe disconnect, and `DiscoveryInfo` / `WorkspaceInfo` serialize/deserialize correctly via kotlinx.serialization — including the security invariant that `DiscoveryInfo` JSON contains no `token` field. These are pure unit tests with no IntelliJ Platform application context required.

## Design Patterns
- **JUnit 5 (`@Test`, `@DisplayName`)**: All tests use `org.junit.jupiter.api` annotations (BridgeSkeletonTest.kt:9-10). No IntelliJ test framework dependency.
- **Pure Unit Tests (no application context)**: Service classes are instantiated directly via constructors (`ReadinessManager()`, `BridgeDaemonConnectionService()`), not via `getInstance()`. This avoids needing a full IntelliJ application context (BridgeSkeletonTest.kt:12-23 comment). This works because the services have no constructor dependencies on IntelliJ container-managed objects (except `BridgeProjectService` which takes a `Project` — not tested here).
- **Security Invariant Testing**: `discoveryInfoSerializationRoundTrip` asserts `json.contains("token")` is `false` (BridgeSkeletonTest.kt:111), enforcing the AGENTS.md §4 rule that the token never appears in serialized data.
- **Enum Completeness Testing**: `readinessStateHasAllIdbpStates` (BridgeSkeletonTest.kt:139) asserts the enum has exactly `INITIALIZING`, `INDEXING`, `READY`, `DEGRADED`, `DISCONNECTED` — catching accidental additions or removals.

## Key Types
- `BridgeSkeletonTest` (BridgeSkeletonTest.kt:25) — `class`. Annotated `@DisplayName("IDE Bridge Plugin Skeleton Smoke Tests")`. Contains 8 test methods.

## Key Functions
- `readinessManagerInitialState()` (BridgeSkeletonTest.kt:29) — Asserts `ReadinessManager()` starts in `DISCONNECTED` state.
- `readinessManagerStateTransition()` (BridgeSkeletonTest.kt:40) — Transitions through `INITIALIZING` → `INDEXING` → `READY` → `DEGRADED`. Asserts `isIndexReady()` is `false` during `INDEXING` (line 47), `true` for `READY` (line 51) and `DEGRADED` (line 55).
- `readinessManagerRedundantTransition()` (BridgeSkeletonTest.kt:60) — Asserts `setState` with the same value is idempotent (no change, no error).
- `daemonConnectionServiceInitialState()` (BridgeSkeletonTest.kt:73) — Asserts `BridgeDaemonConnectionService()` starts with `isConnected() == false`.
- `daemonConnectionServiceDisconnectWhenNotConnected()` (BridgeSkeletonTest.kt:80) — Asserts `disconnect()` is safe when already disconnected.
- `discoveryInfoSerializationRoundTrip()` (BridgeSkeletonTest.kt:88) — Creates `DiscoveryInfo` with test values, encodes to JSON via `Json.encodeToString`, decodes via `Json.decodeFromString`, asserts all fields match. Critically asserts `json.contains("token")` is `false` (line 111).
- `workspaceInfoSerializationRoundTrip()` (BridgeSkeletonTest.kt:115) — Creates `WorkspaceInfo` with test values (`workspaceId="ws_42"`, `rootUri="file:///home/user/project"`, `displayName="test-project"`), round-trips through JSON, asserts all fields match.
- `readinessStateHasAllIdbpStates()` (BridgeSkeletonTest.kt:139) — Collects `ReadinessState.values().map { it.name }` into a set, asserts it equals exactly `{"INITIALIZING", "INDEXING", "READY", "DEGRADED", "DISCONNECTED"}` per TASK.md §13.

## Data & Control Flow
No data flow — tests are isolated. Each test method constructs service/data-class instances directly, performs assertions, and exits. No shared state, no test fixtures, no mocks.

1. **State tests**: `ReadinessManager()` → `setState(...)` → `getState()` / `isIndexReady()` → `assertEquals` / `assertTrue` / `assertFalse`.
2. **Connection tests**: `BridgeDaemonConnectionService()` → `isConnected()` / `disconnect()` → `assertFalse`.
3. **Serialization tests**: Construct data class → `Json.encodeToString(serializer, instance)` → `Json.decodeFromString(serializer, json)` → field-by-field `assertEquals`. Plus `json.contains("token")` security check.

## Integration Points
- **Consumed by**: Gradle test task (`./gradlew test`). No other code depends on this package.
- **Depends on**: `com.idebridge.jetbrains.service.BridgeDaemonConnectionService` (incl. `DiscoveryInfo` nested class), `com.idebridge.jetbrains.service.ReadinessManager` (incl. `ReadinessState` enum), `com.idebridge.jetbrains.service.BridgeProjectService` (incl. `WorkspaceInfo` nested class). `kotlinx.serialization.json.Json`. JUnit 5 (`org.junit.jupiter.api`).
- **External boundaries**: None. No file I/O, no network, no IntelliJ Platform application context.

## Common Gotchas
- **Tests instantiate services directly, not via `getInstance()`** — this works because `ReadinessManager` and `BridgeDaemonConnectionService` have no-arg constructors and no IntelliJ container dependency at construction time (BridgeSkeletonTest.kt:30, 74). `BridgeProjectService` requires a `Project` argument and is therefore not tested here.
- **`BridgeProjectService.WorkspaceInfo` is referenced via fully-qualified name** (BridgeSkeletonTest.kt:117) — there is no import for `BridgeProjectService` itself, only `BridgeDaemonConnectionService` and `ReadinessManager` are imported (lines 3-4). This is intentional to keep the test file's import list minimal.
- **`DiscoveryInfo` test values are hardcoded** — `protocolVersion="0.1.0"`, `endpoint="ws://127.0.0.1:41731/rpc"`, `pid=12345`, `startedAt="2026-08-01T12:00:00Z"` (BridgeSkeletonTest.kt:89-94). These are test fixtures, not protocol constants.
- **The enum completeness test uses `values()`** — deprecated in Kotlin in favor of `entries`, but functional. If the enum changes, this test will fail immediately.
- **No test for `BridgeProjectService.registerWorkspace()` / `unregisterWorkspace()`** — these require a `Project` instance and are deferred to integration tests (Phase 4).
