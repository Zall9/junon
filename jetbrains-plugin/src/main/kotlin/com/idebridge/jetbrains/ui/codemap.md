# jetbrains-plugin/src/main/kotlin/com/idebridge/jetbrains/ui/

## Responsibility

The only user-facing surface the plugin has: a tool window that shows every open project in this
IDE, one row each, and lets each be linked or unlinked; and links to any running JUNON (Serena)
dashboards discovered from per-process registry files. It holds no protocol knowledge and no state
of its own — it reads `BridgeDaemonConnectionService` and calls `link`/`unlink` on it,
`BridgePanelModel` decides what to say, and `JunonDashboards` reads the dashboard registry.

It exists because linking used to be implicit: the first project opened took the single
application-wide connection and every project after it was silently ignored (ADR-0033). Which
project a consumer can reach is a decision about what the IDE exposes, so it belongs to the person
in front of it — and it has to be visible, because "nothing came back" and "this project is not
linked" are answers a consumer cannot tell apart.

Every open project gets a row: its name, whether it is linked and to which workspace, and the one
action that changes that. A panel that could only link its own project left the other windows'
projects describable but not reachable.

## Design Patterns

- **Public API only.** `ToolWindowFactory`, `ToolWindow`, `ContentFactory`, `JBPanel`, `JBLabel`,
  `JBCheckBox`, `JBUI` and plain Swing. The Plugin Verifier runs against four IDEs and
  `internal-api-baseline.txt` fails on anything new; this package adds nothing to that baseline.
- **Model separated from Swing.** `BridgePanelModel` (an `object`, no Swing imports) decides all
  wording, ordering, and enable/disable logic from `Facts`. The panel only draws the result. A test
  can state that a refused project says why without opening a window (BridgePanelModelTest.kt).
- **Off the EDT for I/O.** Linking opens a socket and completes a handshake, so `toggle()` hops to a
  pooled thread via `ApplicationManager.getApplication().executeOnPooledThread`
  (BridgeToolWindowFactory.kt:130) and returns to the EDT through `SwingUtilities.invokeLater`. The
  row's action is disabled while in flight, since a second click would ask the service to link a
  project it is already linking.
- **Disposed with its content.** The panel implements `Disposable` and is set as its content's
  disposer (BridgeToolWindowFactory.kt:44), which is what removes its change listener and
  disconnects its message bus connection — a panel outliving its project would keep being asked to
  repaint a window that no longer exists. Disposing the **content** (not the panel directly) is what
  triggers `dispose()` (BridgeToolWindowFactory.kt:105-108).
- **Two signals, not one.** The service says when a *link* changed; the `OpenProjectsListener`
  topic says when the set of *open projects* did (BridgeToolWindowFactory.kt:98-101). A project that
  opens and is refused a link changes only the second — a panel listening only to the service would
  go on showing a list missing it.
- **Rows rebuilt, not patched.** `refresh()` removes and re-adds every row on every call
  (BridgeToolWindowFactory.kt:163). Pending and refusal state lives in maps keyed by `Project`, so it
  survives the rebuild.

## Key Types

- `BridgeToolWindowFactory` (`BridgeToolWindowFactory.kt:37`) — `class : ToolWindowFactory`.
  Registered via the `ToolWindowFactory` extension point in `plugin.xml` as tool window id
  `IDE Bridge`, anchored right.
- `BridgeToolWindowFactory.BridgePanel` (private inner class, `BridgeToolWindowFactory.kt:48-296`)
  — `JBPanel<BridgePanel>(BorderLayout())` implementing `com.intellij.openapi.Disposable`. Fields:
  - `service = BridgeDaemonConnectionService.getInstance()` (`:51`) — app service singleton.
  - `daemonState: JBLabel` (`:52`) — daemon reachability line.
  - `rows: JBPanel<JBPanel<*>>(GridBagLayout())` (`:55`) — one line per open project, rebuilt on
    every `refresh()` rather than patched in place.
  - `dashboards: JBPanel<JBPanel<*>>(BorderLayout())` (`:58-60`) — links to running JUNON
    dashboards, or a grey line saying none are running.
  - `pending: MutableMap<Project, BridgePanelModel.Pending>` (`:64`) — what is in flight, per
    project. EDT only. Kept here rather than on the buttons because a refresh replaces them.
  - `refusals: MutableMap<Project, Outcome.Refusal>` (`:67`) — the last refusal per project, so a
    row can say why a click changed nothing. EDT only.
  - `listener: () -> Unit` (`:69`) — service change-listener callback, wraps `refresh()` in
    `SwingUtilities.invokeLater`.
  - `connection: MessageBusConnection` (`:70`) — application message bus connection, used to
    subscribe to `OpenProjectsListener.TOPIC`.
  - `warnUnindexed: JBCheckBox` (`:79`) — toggle for index-health warnings (ADR-0034). The panel is
    where the consequence shows up, so the setting is here too.
- `BridgePanelModel` (`BridgePanelModel.kt:16`) — `object`. Pure model: no Swing or platform
  imports. Decides what the panel says from `Facts` and a daemon flag. Testable without an IDE.
  - `Pending` (enum, `:19`) — `LINKING`, `UNLINKING`. An operation the panel has started and not
    yet heard back from.
  - `Facts` (data class, `:22-31`) — one project as the panel knows it at the moment of a repaint:
    `name`, `isPanelProject`, `workspaceId` (or `null`), `pending` (or `null`), `refusal`
    (or `null`).
  - `Row` (data class, `:34-39`) — one row as text and one enabled flag: `title`, `state`,
    `action`, `actionEnabled`.
  - `ORDER: Comparator<Facts>` (`:48-49`) — panel's own project first, rest by name. Decided rather
    than inherited from `ProjectManager.openProjects` order, which reshuffles as windows come and go.
- `JunonDashboards` (`JunonDashboards.kt:30`, internal `object`) — discovers running JUNON
  (Serena) dashboards from per-process JSON files in `~/.ide-bridge/dashboards/` (or
  `IDE_BRIDGE_DASHBOARD_DIR` env var). Each Serena process writes a JSON entry naming its own URL,
  pid and start time; this reads them and keeps only the entries still published by the process that
  published them, since a dashboard that stopped leaves its file behind. No JSON library is used —
  the file has five fields, and the plugin does not carry a parser for this one use (`:26-27`).
  - `Dashboard` (internal data class, `:50-56`) — `url: String`, `pid: Long`, `project: String?`,
    `startedAt: Double?` (epoch seconds; `null` for an entry written before the field existed).
  - `START_TIME_TOLERANCE_SECONDS` (private const, `:48`) — `2.0`. Mirrors
    `_START_TIME_TOLERANCE_SECONDS` in `junon/dashboard_registry.py`; both sides read this file, so
    both must agree. Not zero because the writer and this reader source the same fact differently:
    psutil reports epoch seconds with microseconds, `ProcessHandle.Info.startInstant()` reports whole
    milliseconds (measured on macOS: `1786899750.370856` against `1786899750370`), and Linux rebuilds
    both from clock ticks plus a boot time known only to the second.
  - `directory(): Path` (`:58`) — `IDE_BRIDGE_DASHBOARD_DIR` env var or `~/.ide-bridge/dashboards/`.
  - `running(from: Path): List<Dashboard>` (`:68`) — lists `*.json`, parses, filters by
    `isThePublisher(it)`. Never throws; an unreadable entry is skipped.
  - `parse(path: Path): Dashboard?` (`:81`) — manual field extraction, returns `null` on any failure.
  - `field(text, name): String?` (`:100`) — one field out of a flat JSON object. Handles quoted and
    unquoted forms (`pid` and `started_at` are numbers, `project` may be `null`); returns `null` when
    the field's value is the string `"null"` (`:109`), so a `null` project is read as absent, not as
    the string `"null"`.
  - `isThePublisher(dashboard): Boolean` (`:120`) — the pid must be alive **and** its
    `startInstant()` must match the recorded `startedAt` within the tolerance. Replaced the former
    `alive(pid)`, which asked only whether some process held the number. A missing `startedAt`, or a
    start time the JVM will not give up, is accepted on the pid alone — that is an entry from before
    the field existed, and refusing those would empty the list for every JUNON already running when
    the user updates. Never throws.

## Key Functions

- `createToolWindowContent(project, toolWindow)` (`BridgeToolWindowFactory.kt:39-46`) — builds a
  `BridgePanel`, wraps it in a `Content` whose disposer is the panel (`:44`), adds it to the content
  manager. Disposing the content (not the panel) is what removes the listener and disconnects the
  message bus.
- `BridgePanel.toggle(target: Project)` (private, `BridgeToolWindowFactory.kt:118-147`) — links or
  unlinks any open project (not only this panel's) off the EDT via `executeOnPooledThread` (`:130`),
  then returns to the EDT to store a refusal's reason and refresh. Records `Pending` in the map
  before dispatch and removes it on return, so the row's action stays disabled while in flight.
- `BridgePanel.refresh()` (private, `BridgeToolWindowFactory.kt:154-183`) — rebuilds the daemon
  line, the `warnUnindexed` checkbox state, the dashboard links, and every row. Calls
  `refreshDashboards()` (`:160`), drops pending/refusal entries for closed projects (`:166-167`),
  sorts rows by `BridgePanelModel.ORDER` (`:177`), and delegates each row's text to
  `BridgePanelModel.row(facts, available)`.
- `BridgePanel.notifications()` (private, `BridgeToolWindowFactory.kt:193-219`) — builds the
  notification settings panel: the `warnUnindexed` checkbox (bound to
  `IndexHealthNotifier.isEnabled`/`setEnabled`) and a hint pointing to the IDE's own notification
  settings, which this plugin does not reproduce (ADR-0034). Dashboards sit in `BorderLayout.NORTH`
  (`:207`); notification settings sit in `BorderLayout.CENTER` (`:208-217`).
- `BridgePanel.refreshDashboards()` (private, `BridgeToolWindowFactory.kt:229-254`) — rebuilt on
  every refresh rather than filled once: a dashboard is started and stopped independently of the
  IDE. Calls `JunonDashboards.running()`, heads the section with
  `BridgePanelModel.dashboardLine(running.size)`, and creates an `ActionLink` per dashboard that
  opens `BrowserUtil.browse(url)`. The section stays visible when none are running — it once hid
  itself, and a hidden section is indistinguishable from a plugin that broke.
- `BridgePanel.facts(target: Project)` (private, `BridgeToolWindowFactory.kt:206-212`) — builds a
  `BridgePanelModel.Facts` from the service's state and the pending/refusal maps.
- `BridgePanel.addRow(row, target, index)` (private, `BridgeToolWindowFactory.kt:264-274`) — adds
  one project's title, state label, and action button to the grid. The button's action listener
  calls `toggle(target)`.
- `BridgePanel.openProjects()` (private, `BridgeToolWindowFactory.kt:282-283`) —
  `ProjectManager.getInstance().openProjects.filter { !it.isDisposed }`. A disposed project is
  dropped rather than drawn.
- `BridgePanel.dispose()` (`BridgeToolWindowFactory.kt:105-108`) — removes the change listener from
  the service and disconnects the message bus connection. Called when the panel's content is
  disposed.
- `BridgePanelModel.daemonLine(available: Boolean): String` (`BridgePanelModel.kt:51-55`) —
  `"Daemon: reachable"` or `"Daemon: none found — start one with \`ide-bridge daemon\`"`.
- `BridgePanelModel.dashboardLine(running: Int): String` (`BridgePanelModel.kt:67-71`) —
  `"JUNON dashboard"`, or a line naming the only cause of an empty list: Serena was started as
  `serena` (plain Serena, which publishes nothing) rather than `junon`.
- `BridgePanelModel.row(facts: Facts, daemonAvailable: Boolean): Row` (`BridgePanelModel.kt:57-72`)
  — decides title (`isPanelProject` → `"name (this project)"`), state (via private `state()`),
  action text (pending → `"Linking…"`/`"Unlinking…"`, else `"Link"`/`"Unlink"`), and
  `actionEnabled` (disabled when pending, or when not linked and no daemon — unlinking stays
  clickable because the link is this IDE's to release whether or not anything is listening).
- `BridgePanelModel.explain(reason: Refusal): String` (`BridgePanelModel.kt:80-86`) — maps each
  `Refusal` enum value to a human-readable string: `NO_DAEMON` → "no daemon is running",
  `NO_CONTENT_ROOT` → "this project publishes no content root yet", `UNREACHABLE` → "the daemon
  refused the connection", `HANDSHAKE_REFUSED` → "the daemon refused the handshake",
  `REGISTRATION_REFUSED` → "the daemon refused the registration". A `Refused` outcome carries a
  typed reason so this is possible (ADR-0033).
- `BridgePanelModel.state(facts: Facts): String` (private, `BridgePanelModel.kt:88-94`) — renders
  the state text: pending → `"linking…"`/`"unlinking…"`, linked → `"linked as {workspaceId}"`,
  refused → `"not linked — {explain(reason)}"`, else `"not linked"`.

## Data & Control Flow

1. **Tool window opens**: platform calls `createToolWindowContent` → `BridgePanel(project)` →
   `init` adds `daemonState`, `rows`, `notifications()` (which includes the `dashboards` panel) to the
   layout → subscribes to `BridgeDaemonConnectionService` change listener and
   `OpenProjectsListener.TOPIC` → `refresh()`.
2. **A link changes** (this panel or another window's): service fires change listener →
   `SwingUtilities.invokeLater { refresh() }` → rebuilds every row from the service.
3. **An open project changes** (opens or closes): `OpenProjectsListener.announce()` fires on the
   message bus → `SwingUtilities.invokeLater { refresh() }` → rebuilds the row list. This is
   separate from the service listener because a project that opens and is refused a link changes
   no link at all.
4. **User clicks Link/Unlink**: `toggle(target)` → records `Pending` in the map, clears the old
   refusal, refreshes → dispatches to `executeOnPooledThread` → `service.link(target)` or
   `service.unlink(target)` → back on EDT: clears pending, stores refusal if refused, refreshes.
5. **Project closes**: content is disposed → `dispose()` removes the service listener and
   disconnects the message bus.

## Integration Points

- **Depends on:** `service.BridgeDaemonConnectionService` (`link`, `unlink`, `isLinked`,
  `workspaceIdOf`, `daemonAvailable`, `addChangeListener`, `removeChangeListener`),
  `service.IndexHealthNotifier` (`isEnabled`, `setEnabled`, `warnNoSourceRoots`),
  `lifecycle.OpenProjectsListener` (`TOPIC`, `announce`). The service is obtained via
  `BridgeDaemonConnectionService.getInstance()` — an app-level singleton.
- **Consumed by:** the platform, through the `toolWindow` extension point registered in
  `plugin.xml`.
- **Does not touch:** PSI, the protocol types, or the daemon directly.

## Common Gotchas

- **Disposing the content removes the listener, not disposing the panel.** The panel is set as the
  content's disposer (`:44`); when the content is disposed, the platform calls `panel.dispose()`,
  which removes the change listener and disconnects the message bus (`:105-108`).
- **Linking runs off the EDT.** `toggle()` dispatches to `executeOnPooledThread` (`:130`) because
  linking opens a socket and completes a handshake — both blocking. The row's action is disabled
  while in flight via the `pending` map, not via the button itself (a refresh replaces the button).
- **Row action disabled when no daemon and not linked.** `BridgePanelModel.row` sets
  `actionEnabled = facts.pending == null && (linked || daemonAvailable)` (BridgePanelModel.kt:70) —
  unlinking stays clickable because the link is this IDE's to release whether or not anything is
  still listening. A button whose only outcome is failure is a worse answer than saying why it is
  unavailable.
- **No PSI, no read actions here.** Everything this panel needs is already a `String` or a
  `Boolean` on the service; if that stops being true, the work belongs in the service and not in a
  repaint.
- **Every open project gets a row, not just this panel's.** The panel's own project is
  distinguished by `isPanelProject` in `Facts` and named `"name (this project)"`. The old codemap's
  "others computed by exclusion" no longer applies — every project is listed, and each can be
  linked or unlinked from any panel.
- **Two separate signals.** The service listener fires on link changes; the `OpenProjectsListener`
  topic fires on open-project-set changes. A panel that listened only to the service would miss a
  project that opened and was refused a link (`:98-101`).
- **`warnUnindexed` is re-read on every refresh.** The setting is application-wide, so another
  window's panel may have changed it since this one was drawn (`:154`).
- **References ADR-0033.** The old implicit linking behavior — first project took the single
  connection, rest silently ignored — is what this panel replaced.
- **References ADR-0034.** The `warnUnindexed` checkbox and `IndexHealthNotifier` integration exist
  because a project whose files sit in no source root is indexed for nothing, and the person who
  can fix it is the one reading the empty search result.
- **`JunonDashboards` carries no JSON library.** The dashboard registry file has five fields (`url`,
  `pid`, `project`, `started_at`, and a wrapper), and manual extraction via `field()` (`:100`) avoids
  pulling a parser dependency for this single use (`:26-27`). Anything more elaborate belongs in a
  parser, and anything that needs a parser does not belong in this file.
- **Dead dashboards leave their files behind.** A JUNON process that stopped does not remove its
  registry entry, so the entry is checked before an address is offered: sending someone to a dead
  port is worse than showing no link at all.
- **A pid is not a process.** Pids are reused, and these files outlive their processes — fourteen
  were found in one directory, three days old, all dead. Checking only `ProcessHandle.of(pid).isAlive`
  calls such an entry live as soon as the kernel hands its number to something unrelated, and the
  tool window then offers a link to a port that is not a dashboard: precisely the outcome the
  liveness check exists to prevent. `isThePublisher` (`:120`) therefore also requires the recorded
  `started_at` to match the live process's `startInstant()`.
- **The two sides of the registry must change together.** `junon/dashboard_registry.py` writes these
  files and `JunonDashboards` reads them, and the Kotlin test fixtures
  (`JunonDashboardsTest.kt`) are hand-copied from what the Python side writes. A field added on one
  side and not the other, or a tolerance tightened here but not there, shows up as a tool window
  quietly offering nothing — so the tolerance constant names its Python counterpart, and the test
  file carries a real entry verbatim for comparison.
