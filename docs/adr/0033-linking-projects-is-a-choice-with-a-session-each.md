# ADR-0033 — Linking projects is a choice, with a session each

## Status

Accepted — 2026-08-10

## Context

The JetBrains adapter connected itself. A `postStartupActivity` called `connect(project)` when a
project opened, and an application-level service held one `connected` flag, one socket, one
`AdapterBackend` bound to one workspace. `disconnect()` had exactly one caller: `appClosing`.

Measured in a real sandbox IDE on 2026-08-10, driving it from a consumer through the real daemon:

1. First project opened → `connected; serving workspace ws_…`. Working.
2. That project closed → `projectClosing` called a Phase 0 skeleton whose `unregisterWorkspace()` only
   logged, so nothing was released. The serving thread died on the disposed `Project` and the daemon
   dropped the adapter (`bridge/listAdapters` → `[]`), while `connected` stayed `true`.
3. Second project opened → `connect()` hit `if (connected) return true` and returned **without logging
   anything**. `bridge/listAdapters` stayed empty. No project could register again until the IDE was
   restarted.

The readiness state said `DISCONNECTED` throughout step 3 while the service believed it was connected.
Two views of one fact, disagreeing, with nothing to reconcile them — which is why this survived every
test: no fixture opens a second project, and the log line that would have shown it was never written.

Underneath the defect sits a question the code answered by accident: **which project does this IDE
expose to a consumer?** With one connection and an auto-link on open, the answer was "whichever opened
first", never stated and impossible to change.

## Decision

### A link per project, and the user chooses

- The connection service holds a **map of project → link**, each link its own socket, handshake,
  registration and serving thread. Opening a project links it; closing it releases the link.
- `link` is idempotent and **typed**: `Linked`, `AlreadyLinked`, or `Refused` with a reason —
  `NO_DAEMON`, `NO_CONTENT_ROOT`, `UNREACHABLE`, `HANDSHAKE_REFUSED`, `REGISTRATION_REFUSED`. A bare
  `false` is what let a broken link read as a decision not to link.
- Readiness is derived from the map rather than tracked beside it, so the two cannot disagree again.

### A tool window is where that choice lives

A project-level panel (`IDE Bridge`, right edge) states three things that were previously unknowable
from inside the IDE: whether a daemon is reachable at all, whether **this** project is linked and to
which workspace, and which other projects this IDE is currently serving. It links and unlinks on
demand, off the EDT, and shows a refusal's reason.

Which project a consumer can reach is a decision about what the IDE exposes. It belongs to the person
in front of it, and it has to be visible: "nothing came back" and "this project is not linked" are
answers a consumer cannot tell apart.

### One session per project, not several workspaces per session

`ide/register` creates an adapter **and** its workspaces in a single call, and the protocol has no
route that adds a workspace to a live session (`ide/unregister` only removes one). Serving several
projects over one session would therefore be a **protocol** change — a new method or notification,
schemas, daemon validation, client support and an ADR of its own — not an adapter change.

The daemon already accepts many adapter sessions; that is how two IDEs connect at once. So each linked
project gets its own session, which is the arrangement that exists today and needs nothing invented.
This is a real difference from what a reader might assume: two linked projects appear to a consumer as
**two adapters**, not one adapter with two workspaces.

## Consequences

- Switching projects works. Closing one releases its link; opening another links it. The state a real
  IDE run found — permanently dead until restart — cannot recur, and a refusal now says why.
- More than one project can be served at once, each visible in every panel's "other linked projects".
- A consumer sees one adapter per linked project. Anything wanting a single adapter spanning projects
  needs the protocol change described above; it is not attempted here.
- Auto-link on project open is kept, so the existing single-project flow is unchanged for anyone who
  never opens the panel. The panel is what makes it reversible.
- `BridgeProjectService` remains a Phase 0 skeleton, but nothing calls its no-op
  `unregisterWorkspace()` any more — that call is what made the log read as though a workspace had been
  released. Its remaining users are a serialization test and its own `WorkspaceInfo` type.
- The service takes its discovery path as a constructor parameter with a default. This exists because
  the first version of these tests asserted "no daemon is running" and failed on a machine where one
  was: the fixture project linked to it for real. A test whose result depends on what else runs on the
  machine tests the machine.

## Alternatives considered

### Reset the flag on project close and keep one connection

The minimal fix, and it would have stopped the silent death. Rejected because it keeps the
accidental answer to "which project is exposed" — the first one opened wins, with no way to see or
change it, and a second project still silently ignored.

### Extend the protocol so one session carries many workspaces

The arrangement a reader would probably expect, and possibly right eventually. Rejected **now**: it
requires a wire change across schemas, daemon authority checks and both clients, and the defect in
front of us is a lifecycle bug that a per-project session fixes without touching the contract. Recorded
here so the choice is visible rather than implied by the code.

### Make linking fully manual

Rejected: it would silently stop bridging for every existing setup on upgrade, which is a worse
surprise than the one being fixed. Auto-link on open, reversible from the panel, keeps today's
behaviour and adds the choice.
