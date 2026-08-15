# jetbrains-plugin/src/test/kotlin/com/idebridge/jetbrains/ui/

## Responsibility

Unit tests for `BridgePanelModel` — the pure model that decides what the `IDE Bridge` tool window
says about each open project. The model has no Swing or platform imports, so these tests state
what the panel would render without opening a window (BridgePanelModel.kt:13-15 comment).

The rule these tests exist to protect is ADR-0033's: a click that changes nothing must say why
(BridgePanelModelTest.kt:18 comment).

## Design Patterns

- **Pure model under test.** `BridgePanelModel` is an `object` with no Swing dependencies. Tests
  build `Facts` and call `BridgePanelModel.row()` / `BridgePanelModel.daemonLine()` directly.
- **Helper factory.** A private `facts()` helper (BridgePanelModelTest.kt:22-28) builds
  `BridgePanelModel.Facts` with defaults (`isPanelProject = false`, `workspaceId = null`,
  `pending = null`, `refusal = null`) so each test sets only the fields it cares about.
- **Backtick test names.** Test methods use descriptive Kotlin backtick names that read as
  sentences, matching the style of the main source.
- **kotlin.test assertions.** `assertEquals`, `assertTrue`, `assertFalse` from `kotlin.test`.

## Key Types

- `BridgePanelModelTest` (BridgePanelModelTest.kt:20) — `class`. Ten tests covering
  `BridgePanelModel` ordering, wording, action enable/disable, refusal display, pending states, and
  daemon line.

## Key Functions

- `facts(name, isPanelProject, workspaceId, pending, refusal)` (private,
  BridgePanelModelTest.kt:22-28) — helper that constructs `BridgePanelModel.Facts` with defaults,
  so a test sets only the fields under test.
- `` `the panel's own project comes first, the rest by name` `` (BridgePanelModelTest.kt:31-38) —
  sorts three projects with `BridgePanelModel.ORDER` and asserts the panel's own project (`mine`)
  comes first, rest alphabetical (`alpha`, `zeta`) — not in `ProjectManager.openProjects` order.
- `` `the panel's own project is named as such, the others are not` ``
  (BridgePanelModelTest.kt:41-44) — asserts `row.title` is `"mine (this project)"` when
  `isPanelProject`, plain `"other"` otherwise.
- `` `a linked project shows the workspace it serves and offers to unlink` ``
  (BridgePanelModelTest.kt:47-53) — asserts state is `"linked as ws_abc"`, action is `"Unlink"`, and
  `actionEnabled` is `true`.
- `` `unlinking stays available when the daemon has gone` `` (BridgePanelModelTest.kt:56-63) —
  asserts that a linked project's `Unlink` action stays enabled even when `daemonAvailable = false`.
  The link is this IDE's to release whether or not anything is still listening.
- `` `linking is offered only when there is a daemon to link to` ``
  (BridgePanelModelTest.kt:66-71) — asserts `actionEnabled` is `true` when daemon is available,
  `false` when not. A button whose only outcome is failure is a worse answer than the stated reason
  in the daemon line.
- `` `a refusal is stated on the row it was refused for` `` (BridgePanelModelTest.kt:74-81) —
  asserts a refused row shows `"not linked — this project publishes no content root yet"` while
  another project's row stays `"not linked"`. One refusal must not read as everyone's.
- `` `every refusal reason has words, so none can reach a row as an enum name` ``
  (BridgePanelModelTest.kt:84-90) — iterates `Refusal.entries`, asserts each produces a state
  starting with `"not linked — "` and never containing the raw enum name.
- `` `a project mid-link says so and cannot be clicked again` ``
  (BridgePanelModelTest.kt:93-101) — asserts `Pending.LINKING` produces state `"linking…"`, action
  `"Linking…"`, and `actionEnabled = false`. A second click would ask the service to link a project
  it is already linking.
- `` `a project mid-unlink is disabled even though it is still linked` ``
  (BridgePanelModelTest.kt:104-112) — asserts `Pending.UNLINKING` with a workspace id produces state
  `"unlinking…"` and `actionEnabled = false`.
- `` `the daemon line separates nothing listening from nothing linked` ``
  (BridgePanelModelTest.kt:115-120) — asserts `daemonLine(true)` is `"Daemon: reachable"` and
  `daemonLine(false)` contains `"ide-bridge daemon"`. Two different facts stated in two different
  places.

## Integration Points

- **Depends on**: `com.idebridge.jetbrains.ui.BridgePanelModel` (the model under test),
  `com.idebridge.jetbrains.service.BridgeDaemonConnectionService.Outcome.Refusal` (enum used in
  `Facts.refusal`).
- **Does not depend on**: Swing, IntelliJ Platform, or any IDE runtime. Tests run as plain Kotlin.

## Common Gotchas

- **Tests are Swing-free.** `BridgePanelModel` deliberately imports nothing from Swing or the
  platform (BridgePanelModel.kt:13-15). If a test starts needing `JBLabel` or `Project`, the model
  has leaked a concern that belongs in `BridgeToolWindowFactory`.
- **`Refusal.entries` is exhaustive.** The enum-iteration test (BridgePanelModelTest.kt:85) fails
  if a new `Refusal` value is added without a corresponding `explain()` branch — so a refusal can
  never reach the panel as an unexplained enum name.
