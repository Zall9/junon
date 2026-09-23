# Starting a session must not start a project

**Status:** done — released as 0.3.8 on 2026-09-21, reopened and completed as 0.3.9 on 2026-09-23
([Phase 6](#phase-6--reopened-what-opencode-2-actually-asks)). See the [update log](#7-update-log).

## 1. Why

Measured on 2026-09-21, seconds after launching opencode:

| | |
| --- | --- |
| Shared instances running | **23** — one per registered project |
| Language-server children | **55** |
| Resident memory | **4 160 MB** |
| `opencode serve` direct children | 119 |

opencode starts one MCP server per *registered* project when it launches; that is its design and
nothing here changes it. What this project contributes is that **`junon attach` starts the shared
instance eagerly** — at open, before the session has asked for anything — so every registered project
boots its language servers whether or not anyone will touch it. The relay alone is ~20 MB; the
instance and its language servers are the whole of the 4 GB.

A session that is never used should cost a relay and nothing else.

## 2. What makes it hard

The relay cannot stay empty through start-up, because a host asks two things immediately:

- **`initialize`**, whose result carries Serena's `instructions` — the "read the Instructions Manual"
  text the model is supposed to see. Answering without them is a regression in behaviour that no
  test would catch.
- **`tools/list`**, which the host uses to populate the session's toolset.

Both are answered today by asking the instance, which is what forces it to exist.

## 3. Design

**Answer start-up from a cache; start the instance on the first real call.**

The relay records, the first time it does have a live instance, the two things start-up needs:
the `initialize` result's instructions and the tool list, under
`~/.ide-bridge/junon/handshake/<version>.json`, keyed by **JUNON version alone**.

That key was chosen against the first draft of this plan, which said *project root + version* on the
reasoning that Serena's per-project excluded tools could differ. Phase 0 measured it instead: ten
live instances across ten unrelated projects returned byte-identical instructions and the same
thirty-nine tools. Keying by project too would have made every project pay one eager start after
every release — the exact cost this exists to remove — to guard against a difference that was not
there. With a version key, the first project started after an upgrade primes the cache for all of
them.

A later attach on the same key answers `initialize` and `tools/list` from that file, with no
instance at all. The instance is found or started on the first request that genuinely needs it — a
`tools/call`, a prompt — and from then on everything behaves exactly as it does today.

**A stale cache corrects itself.** When the instance does start, its real tool list is compared with
the cached one; if they differ, the relay sends `tools/list_changed`, which the host already handles
(it is relayed today for exactly this reason). The cost of staleness is therefore one refresh, not a
wrong answer.

**No cache, no cleverness.** The first attach for a root at a new version has nothing to read and
behaves as it does now: start the instance, answer, and write the cache for next time.

### Decisions taken

| Decision | Reason |
| --- | --- |
| Cache keyed by version alone | Measured, not assumed: ten projects, one signature. A per-project key would cost one eager start per project per release |
| Only `initialize` and `tools/list` may be answered from cache | Everything else is a real question about a real project; answering it from a file would be inventing |
| A differing tool list triggers `tools/list_changed`, not an error | The mechanism already exists and the host already obeys it |
| The eager path stays as the fallback | A machine with no cache must still work, and identically |

### Out of scope

- Making the relay itself lighter (it imports `serena.cli` to resolve a root, most of its 20 MB).
- Anything about how many MCP servers opencode chooses to start.

## 4. The second defect, fixed in the same pass

During the same stampede two instances appeared for one root (`/Users/pauldelifer/dev/musa`, pids
22600 and 22809). `find_or_start` treats an entry that is registered but **not yet answering** as
absent, and the per-root lock is released before the instance answers — so with twenty-three
instances booting at once, the second attach did not wait long enough and started another. Inside the
lock, a registered-but-silent instance now gets a bounded wait before a second one is started.

## 5. Phases

### Phase 0 — Measure what the cache must hold

**Status:** done 2026-09-21 — **the key is the version alone**, and that is measured.

Ten live instances were asked for their instructions and their tool lists: ten unrelated projects —
Go, PHP, TypeScript, Swift — **one signature**. Byte-identical instructions (130 characters, the
"read the Instructions Manual" line) and the same thirty-nine tools, every one of them.

That decided the design rather than confirming it. Keying by project as well would have been safer
in theory and much worse in practice: every project would pay one eager start after each release,
which is the whole cost this exists to remove. With a version key, the first project to start after
an upgrade primes the cache for all twenty-three.

### Phase 1 — The handshake cache

**Status:** done 2026-09-21 — `junon/handshake_cache.py`, `tests/test_lazy_attach.py`

Written when an instance is live, read at open, ignored when damaged or empty — a machine that has
never run one behaves exactly as it did before.

**Acceptance met:** with a cache present, `initialize` and `tools/list` are answered with no
instance running and none started, asserted by counting `junon serve` processes across the call.

### Phase 2 — Lazy start on first use

**Status:** done 2026-09-21 — the relay opens its upstream from `call_tool` and the prompt handlers,
never from start-up.

**Acceptance met:** a session that opens and lists tools starts nothing; the first tool call starts
exactly one instance and returns the real answer; a deliberately wrong cached toolset is served at
start-up, then rewritten on first use with `tools/list_changed` sent — the test asserts the file is
corrected and the call still reaches the real instance.

### Phase 3 — The bounded wait

**Status:** done 2026-09-21 — a registered-but-silent instance is given 30 s inside the lock.

It also has to survive a still clock: the first version looped for ever against a test that injects
one, and hung the suite. A wait whose clock does not advance cannot expire, so it breaks instead —
written down in the code, because the next person to read it will wonder.

**Acceptance met:** `test_two_sessions_starting_at_the_same_moment_still_share_one_instance` and the
seven `find_or_start` unit tests pass, the latter in 0.8 s rather than for ever.

### Phase 4 — End to end, no regression

**Status:** done 2026-09-21 — every item run, and the tests that cover them proved by mutation.

| # | The behaviour that must still hold | What ran |
| --- | --- | --- |
| 1 | Two sessions share one instance, the second quick | `test_two_attaches_share_one_instance_and_the_second_is_quick` — one instance, two clients, second answer well under the budget |
| 2 | A replaced instance is followed (0.3.7) | `test_a_session_follows_its_instance_when_it_is_replaced` |
| 3 | An in-flight call is unknown, never retried | `test_a_call_in_flight_when_the_instance_dies_is_reported_and_never_retried` |
| 4 | The client entry follows the new instance | asserted inside 2, while the session is still up |
| 5 | `instances`, `--stop`, `--stop --all` | `test_stopping_every_instance_leaves_the_sessions_working` and the whole of `test_stop_instances.py` |
| 6 | A superseded instance is never offered | `test_a_session_does_not_attach_to_an_instance_running_an_older_junon` |
| 7 | Cross-project through an explicit root | `test_a_session_elsewhere_reaches_this_project_through_an_explicit_root` |
| 8 | The install click | the whole of `test_update_action.py` |
| 9 | The three suites, and the measured start-up | 417 Python, 488 TypeScript, 301 Kotlin; 8 sessions → **8 instances / 5 717 MB before, 0 / 0 after** |

**And the acceptance left over from Phase 3, now run:** twenty relays opened at the same instant on
one root started **nothing**; the same twenty then calling a tool at the same instant were served by
**one** instance — the same pid reported by all twenty, in 8.6 s.

#### Two defects this phase found, neither of them in the feature

The first full pass failed two of the lazy tests and passed on a rerun. A green rerun is the worst
possible answer, so the cause was found rather than accepted: the tests counted `junon serve`
processes **across the machine**, filtered by repository path. An instance started by the user's own
agent host on this very repository, while the suite ran, was counted as a start the test had caused
— and then terminated by the test's own cleanup. Proved rather than argued: a foreign instance for
this repository is visible to the old filter and invisible to the new count, which reads the test's
own registry. `test_attach.py` had exactly the same defect and the same cure.

The second came from reading the diff. Three things were hardened, each now pinned:

- a recorded tool the SDK would refuse used to fail `tools/list` at start-up, which is worse than
  the eager start this replaces; the file is validated when it is read, and ignored if it is wrong;
- recording the handshake could not fail safely — a read-only registry would have taken the session
  down with it; it now warns and carries on;
- with nothing recorded, the prompts capability is again exactly the instance's own, not always on.

#### Proved by mutation, on a copy, with a green control first

| Mutation | Result |
| --- | --- |
| Drop the validation of a recorded toolset | red |
| Answer `tools/list` from the instance instead of the file | red |
| Stop reconciling a stale cache on first use | red |
| Remove the deliberate open in `call_tool` | **green** — and that mattered |

The last one is why this table is here. Everything still passed, because `Upstream.call` reconnects
when it finds no session, so the instance started anyway. What was lost was invisible to every
assertion in the file: the first call reached its instance *as a reconnection*, which tells the host
its toolset changed and logs an instance change that never happened — once per session, for ever.
`test_a_correct_cache_says_nothing_to_the_host` was written for it, with the opposite case asserted
in the stale-cache test, and the mutation is red now.

### Phase 5 — Release

**Status:** done 2026-09-21 — **0.3.8 is out, and the machine was measured rather than assumed.**

Run with the binary an agent host actually launches — `/Users/pauldelifer/.local/bin/junon` — against
the machine's own registry, not an isolated one:

| | |
| --- | --- |
| Version reported by the installed JUNON | 0.3.8 |
| Recorded handshake for 0.3.8, before | absent |
| A session that calls a tool | started one instance in 4.0 s, and recorded the handshake |
| Six sessions on six real projects, `initialize` + `tools/list` | **0 instances started**, 39 tools each, 3.2 s |

The one instance this measurement started was stopped by its pid; the one that was already on the
machine was left alone.

#### What the release itself turned up

`scripts/update-all.sh` reported *none was running*, then *the daemon did not restart*, while a daemon
was running, answering, with two IDEs attached. It looked for
`pgrep -f 'node packages/cli/dist/bin.js daemon'` — the relative command a daemon started from the
repository root has. Since 0.3.7 a daemon normally starts from the recorded command in
`~/.ide-bridge/daemon.json`, in absolute paths, so the half added to make the daemon self-healing had
made it invisible to the script that updates it. It never stopped the old daemon, could not start a
new one, and left the machine on the previous build while reporting a failed step. It now asks the
discovery file, which is what `doctor` and the plugin have always done. Re-run: pid 90957 stopped,
92498 started, daemon at 0.3.8.

#### Left to the person who owns the IDEs

GoLand and PhpStorm were running, so their plugins are still 0.3.7 — no script can write into a
running IDE. Quitting them and pressing install, or running the script again, finishes it. Agent
hosts pick up 0.3.8 when they next start, since JUNON is imported at start-up.

### Phase 6 — Reopened: what opencode 2 actually asks

**Status:** built and proved 2026-09-23; released as 0.3.9.

0.3.8 was proved against a client that sent `initialize` and `tools/list`, because that is what a
host was *assumed* to send. §6 even listed the risk — *a host that calls something else at start-up*
— and accepted it without measuring it. Two days later the machine moved to opencode 2, and the
assumption was false.

**Measured, not assumed.** A stdio tap between each host and `junon attach` writes down every
JSON-RPC message. Both hosts run isolated — their own config and data directories, a scripted local
model instead of a provider, the probe's own JUNON registry — so nothing of the user's is read or
written:

| Host | Sent while a session opens | Instances started, handshake recorded |
| --- | --- | --- |
| opencode 1.18.31 (`mcp list`, and a real `run`) | `initialize`, `tools/list` | **0** |
| opencode 2.0.12 | `initialize`, `tools/list`, **`prompts/list`** — on every relay | **1 per relay** |

The relay answered the first two from the file and opened the instance for `prompts/list`. So under
opencode 2 every session start still started its project — to return, it turned out, an empty list:
Serena advertises prompts and has none.

**A second defect, found by running opencode 2 the way it really runs.** It starts every MCP server
once in its own service's directory as well as once per session, and the service runs in `$HOME`,
which is not a project. `junon attach` exited there with status 2, and opencode 2 then marked the
whole server failed — every relay of that server closed straight after `initialize`, real projects
included. On the machine: `serena failed: Connection closed` in `$HOME`, moneta, vod/core and
site-api-radios alike. This one was made visible by moving the configuration from a plain
`serena --project-from-cwd`, which never exited in that position, to `junon attach`.

**The fixes.**

- The handshake records the prompt list too, and `prompts/list` is answered from it. Absent is kept
  distinct from empty: a file written by 0.3.8 has no list, and that makes the relay ask the
  instance exactly as 0.3.8 did, then fill the list in — without telling the host anything changed,
  because nothing did.
- Outside any project, the relay no longer exits. It stays up, offers **no tools** — not the recorded
  ones, since a host merging what one server offers in several directories could route a session's
  call by name to a relay that can only refuse it — and answers any call that reaches it with a
  sentence saying what to do.

**Proved.**

| What | Result |
| --- | --- |
| Each host's measured opening, replayed against a real relay with a recorded file | 0 instances for both |
| A 0.3.8 file | answered by the instance once, filled in, no notification |
| opencode 2, isolated, service outside any project, three passes | relays stay up, `connected`, 1 then **0** and **0** instances — the first pass filling in a 0.3.8 file |
| opencode 1, in a project and outside one | `connected`, 0 instances |
| The user's real service, relays reconnected in place | `connected` in `$HOME`, moneta, vod/core, site-api-radios; no instance started |

Five mutations, on a copy with a green control first: answering `prompts/list` from the instance
again turns the opencode 2 case red **and leaves the opencode 1 case green** — the test tells the
two hosts apart; priming without the prompt list, not filling in a 0.3.8 file, reading an absent list
as empty, and exiting outside a project each turn their own test red.

## 6. Risks

| Risk | Decision |
| --- | --- |
| A cached tool list that no longer matches | Compared on first use, `tools/list_changed` sent; one refresh, never a wrong answer |
| Cached instructions going stale | Same key as the tools; a release changes the key. Accepted and stated |
| A host that calls something else at start-up | **Materialised** under opencode 2 (`prompts/list`), accepted here without being measured. Closed in Phase 6 by measuring each host's opening with a tap rather than assuming it |
| A relay started outside any project | Found in Phase 6: exiting made opencode 2 fail the server everywhere. It now stays up with no tools |
| Lazy start hiding a broken project until the first call | The first call reports the failure the same way the open would have |

## 7. Update log

| When | What |
| --- | --- |
| 2026-09-23 | Reopened as Phase 6 after the machine moved to opencode 2. Measured with a stdio tap: opencode 2 asks `prompts/list` on every relay, which 0.3.8 answered by starting the project. And a relay started outside any project exited, which made opencode 2 fail the server in every directory — JUNON was gone from every session on the machine, found by asking the live service. Both fixed and proved against both real hosts. |
| 2026-09-21 | Plan written after measuring 23 instances / 55 language servers / 4.16 GB at opencode start-up, caused by `attach` starting its instance eagerly. |
| 2026-09-21 | Phase 5 done: 0.3.8 pushed and installed. Measured on the machine with the installed binary and the real registry — six sessions on six real projects started nothing. One more defect found by doing it for real: the update script could not see a daemon it had not started itself, so it left the machine on the previous build while saying a step had failed. |
| 2026-09-21 | Phase 4 done: the nine behaviours run one by one, twenty simultaneous attaches accepted, four mutations probed on a copy. Two defects found and fixed — tests that counted (and killed) instances belonging to the user's own sessions, and three unsafe edges in the relay found by reading the diff. |
| 2026-09-21 | Phases 0–3 done. Eight host-like sessions opened at once, each doing what a host does — initialize, `tools/list`, then nothing: **8 instances and 5 717 MB before, 0 and 0 after**. The 14 tests of `test_attach.py` still pass unchanged, which is the point: sharing, reconnection, in-flight semantics and cross-project are untouched. Two mistakes of mine along the way, both recorded in the risks: a `pkill` in a diagnostic script killed the suite that was running, and the first cost measurement counted — and then terminated — every instance on the machine rather than its own. |
