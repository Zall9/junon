# integrations/serena/

## Responsibility

JUNON: the Serena integration. It adds a family of `ide_*` tools that answer from a running IDE
through the daemon — symbols, references, hierarchies, diagnostics, TODOs, quick fixes — so an agent
reads what the IDE knows rather than what a text search can guess.

## Design

**Composed onto Serena, never edited into it.** `compose.py` imports the tool classes so Serena's own
registry discovers them by subclass iteration, then hands over to Serena's CLI unchanged. Running
`serena` directly still gets plain Serena
([ADR-0029](../../docs/adr/0029-serena-is-extended-by-runtime-composition.md)).

**A refusal is a next step, not a failure.** `_explain` keeps the protocol's code verbatim — it is the
part an agent can reason about — and each route adds what it alone knows: what
`CAPABILITY_UNAVAILABLE` means on *this* route, what to do about `STALE_DOCUMENT`, and the revision
the daemon named so the caller need not guess what to re-read.

**One connection per operation, because plans are session-scoped.** `client.session()` exists for
exactly that: preparing on one connection and applying on another is refused `PLAN_NOT_FOUND`,
measured both ways. `ide_apply_fix` therefore does prepare-and-apply in a single call, with `confirm`
separating looking from doing, rather than handing back a plan id that could never be used.

**The websocket is the only transport there is** — no SSE endpoint exists in the daemon
([ADR-0036](../../docs/adr/0036-the-python-client-speaks-the-only-transport-there-is.md)).

## Flow

```
junon/compose.py       registers tools, then delegates to Serena's CLI
junon/tools.py         the ide_* tools; each maps a route and explains its own refusals
junon/client.py        discovery (0600-checked), handshake, one-shot calls and sessions
junon/ide_bridge_status.py   where the discovery file is, and what its absence means
junon/dashboard*.py    the local dashboard and the per-process registry the IDE's tool window reads
ide_bridge/            typed configuration and models shared by the above
```

## Integration

Needs a daemon and an IDE; with neither, every tool answers "no IDE Bridge daemon is reachable",
which is the ordinary state and not an error. `tests/` runs without either.
