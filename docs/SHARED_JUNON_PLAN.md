# One JUNON per project, shared by every session on it

**Status:** in progress — see the [update log](#7-update-log) for where it stands.

## 1. Why

Every agent session starts its own JUNON. Both hosts are configured the same way —
`junon start-mcp-server --project-from-cwd --transport stdio` — so a second opencode session on the
same project is a second process, a second set of language servers, a second indexing pass, and a
second dashboard on the next free port.

Measured on this machine on 2026-09-15, 16:00:

| What | Count |
| --- | --- |
| `junon start-mcp-server` processes alive | **10** |
| of which older than six days, serving no session | 4 |
| resident memory of those plus their language servers | **1 017 MB** |

`dashboard_registry.py` had already recorded the same symptom from the other side: *four dashboards
on 24282, 24283, 24284 and 24286 in one evening*, and *fourteen dead entries found three days later*.

What is wanted instead:

```
project A  ──  JunonA  ◄──  session 1 on A
                       ◄──  session 2 on A
project C  ──  JunonC  ◄──  session 3 on C
                            session 3 also needs A's files  ──►  JunonA
```

One instance per project root, started once, reused by every session, gone when nobody uses it.

## 2. What already exists — the design rests on these, all verified

1. **JUNON delegates to Serena's CLI unchanged** (`integrations/serena/junon/__main__.py`), so every
   Serena flag works: `--transport streamable-http --port N --project /path`.
2. **Serena's HTTP transports share one agent across connections.** `SerenaMCPFactory.server_lifespan`
   (serena 1.7.0, `mcp.py:395–420`): *"For stdio transport, there is a single server instance. For
   other transports, this is called once per connection"* — and on disconnect *"the singleton agent
   instance remains active"*. Upstream built the multi-client mode; nothing here has to.
3. **Tool execution goes through one `TaskExecutor`** (`agent.py:658`, `task_executor.py`), which
   serialises tasks. Two sessions on one instance therefore queue, they do not interleave. Whether
   that queueing is acceptable is Phase 0's measurement, not an assumption.
4. **Both hosts accept a remote MCP server**, and both currently launch JUNON as a local stdio
   command with the project taken from the working directory (`~/.config/opencode/opencode.json`,
   `~/.claude.json`).
5. **A registry with a real liveness check exists**: `dashboard_registry.py` publishes one entry per
   process under `~/.ide-bridge/dashboards/`, keyed by pid **and** start time (ADR-0040). An instance
   registry needs the same shape plus two fields — the project root and the MCP port.
6. **The `ide_*` half already has this architecture.** One daemon per machine, workspaces addressed
   by root, `IdeBridgeTool._workspace_id` matching the active project's root against what the IDE
   has open. The Serena half is the one still per-session.

## 3. Design

Three pieces, in the order they are needed.

### 3.1 `junon serve` — the per-project instance

`junon serve --project ROOT [--port N]` runs Serena's server over `streamable-http` with the project
pinned, and:

- writes an **instance entry** (pid, start time, root, port) beside the dashboard entries;
- **refuses `activate_project`** for any other project. A shared instance that can be switched under
  its other clients is a trap — it happened by hand twice on 2026-09-15 while reading a PHP file from
  a session on another project. The tool stays, and answers that this instance is pinned and how to
  reach the other project instead;
- **exits when idle**: no live client entry for `--idle-minutes` (default to be chosen from Phase 0),
  checked by the same pid-and-start-time rule the dashboard registry uses.

### 3.2 `junon attach` — what the hosts launch

The stdio contract with the hosts stays. `junon attach` resolves the project from the working
directory exactly as `--project-from-cwd` does, looks for a live instance for that root, starts one
with `junon serve` if there is none, waits until it answers, registers itself as a **client entry**,
and proxies stdio ↔ HTTP for the life of the session.

Host configuration changes by one word: `start-mcp-server --project-from-cwd` → `attach`. The
first session on a project still pays the language-server start-up; every later one connects in
well under a second. That number is Phase 2's acceptance criterion.

The proxy is deliberately thin: `tools/list`, `tools/call`, the server's `instructions` from its
initialize result (Serena's *"read the Instructions Manual"* must reach the client), and the
`tools/list_changed` notification. Nothing is reinterpreted.

### 3.3 Cross-project — explicit, not routed

A session on C that needs A adds a second MCP entry: `junon attach --project /path/A`. The host
prefixes that server's tools (`serenaA_find_symbol` in opencode), which says where an answer came
from. Implicit routing — an absolute path inside A sent to JunonA from C's own tools — would add a
project dimension to every tool signature and is **out of scope**; the explicit form does the job.

### Decisions taken

| Decision | Reason |
| --- | --- |
| The instance owns its own death (idle exit), not the shim that spawned it | The spawning session usually ends first; a supervisor that dies with its session leaves the orphans this plan exists to remove. |
| Registry files, not a socket or a daemon of their own | The pattern is already proven here (ADR-0040) and needs no new process to be alive. |
| A new subcommand rather than a flag on `start-mcp-server` | JUNON must intercept it before delegating to Serena's CLI; a flag Serena does not know would be rejected there. |
| Pinning refuses rather than silently ignores | An ignored `activate_project` looks like success; a refusal names the instance to use. |

## 4. Phases

### Phase 0 — Measure the shared instance

**Status:** done 2026-09-15 — decision: **acceptable, and the plan stands; the reason for it moved.**

**Question:** is one instance serving two sessions acceptable, and what does it save?

**Measured** (`docs/evidence/shared-junon-phase0-probe.py`, this repository, TypeScript + Python language servers; then a PHP
project for the start-up figure):

| | Result |
| --- | --- |
| Shared instance, process start → first correct `find_symbol` | 2.22 s |
| Second client on the warm instance, connect → first correct answer | **0.168 s**, `instructions` present |
| Two clients × 20 `find_symbol` on different files, concurrently | 3.97 s wall, **0 wrong or cross-wired answers** |
| Mean call under two-way contention / alone | 0.198 s / 0.105 s — **serialisation doubles per-call latency, throughput is unchanged** (40 calls in 3.97 s, 20 in 2.10 s); worst call 0.217 s, no starvation |
| Language-server processes held by the one instance | 4 — one set |
| Fresh stdio JUNON, the way every session starts today | 1.98 s to first answer; on the PHP project 2.34 s and 1.93 s (intelephense's index is on disk) |

**What this changes.** The start-up saving is real but small — under two seconds per session on
this machine, because every language server here restores an index from disk. A second session does
not wait for anything worth noticing today. What the shared instance buys is what §1 counted: one
set of language servers per project instead of one per session, no instance outliving its sessions
by a week, one dashboard, one project state. The idle exit is the part that removes the orphans; the
sharing is what makes an idle exit safe to apply.

**Cost accepted:** a session's call waits behind the other session's call. At the sizes measured it
is a tenth of a second. A long-running tool from one session (a project-wide search) will hold the
other for its duration; the proxy carries no queue limit for now, and this is re-measured in Phase 2
with a deliberately slow call.

**Idle default chosen:** 30 minutes. Long enough to survive a break in one session and a restart of
the host; short enough that a project left for the evening is gone by the morning.

**Probe:** start one `junon start-mcp-server --transport streamable-http --project <this repo>`;
open two MCP clients; from both, interleave `find_symbol`, `get_symbols_overview` and a
`read_file`, 20 calls each, concurrently. Record: every answer correct and attributable to the right
call; wall time per call under contention versus alone; language-server processes started (expect one
set); time to first answer for the second client versus a fresh stdio start.

**Acceptance:**
1. 40 concurrent calls, 0 wrong or cross-wired answers.
2. Language-server process count for the shared instance = one set.
3. Second client's first answer < 1 s; fresh stdio start-up measured for comparison.
4. Contention cost stated as a number, and a decision recorded: acceptable, or the plan changes.

### Phase 1 — `junon serve`

**Status:** done 2026-09-15 — `junon/serve.py`, `junon/instances.py`, `tests/test_serve.py`,
`tests/test_instances.py`; 20 tests, four rules mutation-proved on a copied tree.

**Deliverables:** the subcommand; instance registry (`~/.ide-bridge/junon/instances/<pid>.json`,
pid + start time + root + port, and `clients/<pid>.json` beside it); the pinned
`activate_project`; idle exit.

**Learned while building it**, each now pinned by a test:

- **A tool override must keep upstream's docstring and signature.** Serena builds the MCP schema
  from `apply`'s signature and docstring *per connection, inside the server lifespan*. The first
  pin dropped them, and every `initialize` against the instance hung — port listening, no session
  ever opened, nothing logged. `functools.wraps(original)` is the fix; the test asserts the
  docstring and the parameter list survive the pin, and the process test bounds every call so this
  fails in 20 s instead of hanging for ever.
- **Language servers leave with the instance whichever way it exits.** Measured with `SIGTERM`,
  `SIGINT` and a bare `os._exit`: no survivor in any of them — they read stdin and stop at
  end-of-file. `SIGTERM` is kept so Serena's own shutdown runs; the survivors check in the test is
  a guard against a future exit path, not a difference between these.
- **A process test must run the code beside it, not the installed one.** `python -m junon` resolves
  through the editable install to the checkout, so a mutation probe on a copy exercised the real
  sources and reported green on a broken copy. `PYTHONPATH` does not beat the editable finder here;
  an explicit `sys.path.insert(0, …)` does, and the test spawns the instance that way. Proved by a
  marker the copy writes and the checkout does not.

**Acceptance — all met:**
1. `junon serve --project X` answers MCP over HTTP on its port and its entry is listed live. ✔
   `TestServeProcess`, against this repository.
2. `activate_project(Y)` on it is refused with a message naming X and the way to reach Y;
   `activate_project(X)` — by path or by registered name — goes to upstream. ✔ `TestPin`.
3. With no live client entry for `--idle-minutes 0.05`, the process exits by itself; with one live
   client entry it does not. A dead client's stale entry counts as absent (pid reused ≠ alive). ✔
   `TestIdleWatchdog` with an injected clock, `TestClients`, and the process test end to end.
4. Mutation-proved on a copy: pin never refuses → red; watchdog ignores sessions → red; `wraps`
   removed → red in 42 s, not a hang; the control mutation writes a marker only the copy can. ✔

### Phase 2 — `junon attach`

**Status:** done 2026-09-15 — `junon/attach.py`, `tests/test_attach.py`; 10 tests, four rules
mutation-proved; both hosts on this machine switched and exercised.

**Deliverables:** the subcommand; project-from-cwd resolution reusing Serena's `find_project_root`;
find-or-start under a per-root lock, with a ready wait; client entry; the stdio ↔ HTTP relay with
the instance's death turned into an answer rather than a closed pipe.

**Acceptance — all met:**
1. Two `junon attach` in the same root → exactly **one** `junon serve` process, counted in the
   process table; both answered. ✔ Also two started **at the same moment** — the race the lock is
   for; without the lock both start one (mutation, red in 62 s). ✔
2. `tools/list` through the relay is the instance's own (39 tools, `ide_*` included);
   `instructions` reach the client. ✔ `tools/list_changed` is relayed by code and not by a test —
   the pinned instance never changes its toolset, so nothing here can provoke one.
3. Second attach, spawn → first correct answer: **0.73 s** (0.743, 0.727, 0.728 over three runs),
   interpreter start included. First attach: the instance's ~2 s plus the same. ✔
4. Instance killed under a session: the next call answers `isError` with *the shared JUNON for …
   stopped answering*; the next session gets a fresh instance with a different pid. ✔ A call on a
   dead connection is raced against the death mark — without the race it waits for a response
   that never comes (mutation, red).
5. `docs/AGENT_SETUP.md` §5 rewritten for `attach`; this machine's `~/.claude.json` and
   `~/.config/opencode/opencode.json` switched (backups beside them). Exercised: a headless
   `opencode run` started an instance through `attach` — its model provider refused the call,
   which is opencode's business, but the MCP side ran — and `claude mcp list` reported
   `serena: junon attach - ✔ Connected` **against the instance opencode had started**. One
   instance, two hosts. ✔

**Learned while building it**, pinned by a test:

- **A new session is not enough to survive the host.** The first real opencode session ended and
  the instance — in its own session via `start_new_session` — received a shutdown the same second.
  The same instance started from a Python stdio client outlived it. Hosts kill their MCP server's
  descendants, presumably by walking the tree; a session boundary is not a tree boundary. The
  instance is now started by a middle process that exits at once, so launchd adopts it; the test
  asserts the instance's parent is pid 1, and starting it directly goes red.
- **The relay's upstream connection must be its own task.** The HTTP transport runs a task group,
  and when the instance dies that group raises; inside the same `async with` as the stdio server,
  the exception closed the host's pipe with no message. Held in a task, its death is a fact the
  next request is answered with.
- **A fake clock that never advances hangs a poll loop forever.** A unit test did, once. The clock
  in that test now ticks on every glance.

### Phase 3 — Cross-project and visibility

**Status:** pending (after Phase 2)

**Deliverables:** `attach --project` documented as the cross-project route with a config example;
`doctor` lists live instances with their roots, ports and client counts; the dashboard shows the
same; orphaned entries reaped on read.

**Acceptance:**
1. From a session on C, a second server `attach --project A` answers about A's files.
2. `doctor` names each live instance and its clients; a killed instance disappears from it.

### Phase 4 — Ship

**Status:** pending (after Phase 3)

`CHANGELOG.md`, `AGENT_SETUP.md`, this document's final numbers, a release.

## 5. Risks and open questions

| Risk | Where it is decided |
| --- | --- |
| Serialised tool execution makes one slow call block the other session | Phase 0 measures it; a queue depth or per-call timeout in the proxy is the fallback |
| Two sessions editing the same file through one instance | No worse than today (two instances, one disk); noted, not solved here |
| Serena's `--project-from-cwd` resolution has rules of its own (nearest `.serena/`, registered names) | Phase 2 reuses Serena's function rather than re-implementing it |
| Port choice collides with something else on loopback | Bind port 0 and publish the port actually obtained |
| A host kills `attach` without a clean exit, leaving a client entry | Liveness is pid + start time; a stale entry is already treated as dead |
| Memories and `.serena/` project config are shared state across sessions | They are today too, on the same disk; concurrent writes are Serena's own concern |

## 6. Out of scope

- Implicit cross-project routing by path.
- A supervisor process of its own.
- Sharing one instance across machines.
- Changing the `ide_*` half — it already has this shape.

## 7. Update log

| When | What |
| --- | --- |
| 2026-09-15 16:10 | Plan written. Facts in §2 verified against serena 1.7.0 in the pipx venv and this machine's host configs; the counts in §1 measured with `ps`. Phase 0 next. |
| 2026-09-15 18:20 | Phase 2 done. `junon attach` relays stdio to the shared instance; two sessions — sequential or simultaneous — share one; a second session answers in 0.73 s; a dead instance is reported in words. Both hosts on this machine switched: opencode started an instance through it and Claude Code's `mcp list` connected to that same instance. Found and fixed on the way: hosts kill their MCP server's descendants, so the instance is re-parented to launchd at birth. 284 Python tests. Phase 3 next. |
| 2026-09-15 17:30 | Phase 1 done. `junon serve` announces itself, refuses other projects, leaves when unused — watched on a real instance. Three things learned the hard way, each pinned: an override without upstream's docstring hangs every `initialize`; language servers die with the instance however it exits; a process test must launch the code beside it or a probe proves nothing. 274 Python tests. Phase 2 next. |
| 2026-09-15 16:35 | Phase 0 done. Two clients on one instance: 0 wrong answers in 40 concurrent calls, per-call latency doubles under contention (0.105 → 0.198 s), one language-server set. The expected start-up gain did not materialise — a fresh session is under 2 s here, PHP included — so §1's case is the process sprawl and the orphans, not speed. Idle default 30 min. Phase 1 next. |
