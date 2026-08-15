# ADR-0035 — The dashboard shows what it can prove

## Status

**Proposed** — 2026-08-11. The panel set and the metrics below are decided here; two questions remain
(one privacy call, one security review) and are named at the end.

## Context

The design supplied on 2026-08-11 (`~/Downloads/junon/index.html`, `dashboard-preview.png`, plus
`favicon.svg`, `junon-emblem.svg`, `junon-logo.svg`) shows a twelve-panel Junon dashboard: memories,
embedding model, active tools, tool-usage percentages, an executions queue, recent semantic searches. The
favicon is already installed as the plugin icon and kept in
`jetbrains-plugin/src/main/resources/icons/` as the single source for the page's own favicon.

Measured against this repository, three and a half of those twelve panels have a source. The other eight
and a half describe a semantic-search backend — memories, embeddings, tool executions — and the project
owner confirmed on 2026-08-11 that **no such backend exists outside this repository**.

That settles what the mockup is: a visual direction, not a specification. Its panels are not waiting for a
source, and rendering them as "not connected" would be decorating an absence — nine permanent apologies
on a page that is supposed to inform. The dashboard has to be designed for the product that exists.

What the product *is*: a daemon that routes a small, bounded set of methods between agents and IDEs, whose
entire value proposition is that it refuses truthfully rather than answering vaguely. That is what a
dashboard for it should show.

## Decision

### The mockup's identity is kept; its panels are replaced by ones with sources

Layout, palette and emblem carry over. The panel set is re-derived from what the daemon and its adapters
can prove. Panels that describe a backend this product does not have are **dropped**, not disabled: a
page of "not connected" tiles teaches the reader to skim past the tiles that mean something.

### v1 panels, and where each number comes from

| Panel | Source | Exists today? |
| --- | --- | --- |
| Daemon | `bridge/getStatus` — version, protocol range, uptime, bind address, session counts | yes |
| Connected IDEs | `bridge/listAdapters` — IDE kind and version, plugin version, connected since, capability map; `ide/ping` for latency | yes |
| Linked projects | `workspace/list` — name, roots, trust, epoch, serving adapter, **index state** (searchable / indexing / no source root, per ADR-0034) | yes |
| Consumers | session registry — which agents are connected, in which role, since when | yes, not yet exposed |
| Method activity | per-method count and latency percentiles | **needs instrumentation** |
| Refusals by reason | count per normalized error code — `INDEX_NOT_READY`, `STALE_SYMBOL`, `AMBIGUOUS_SYMBOL`, `CAPABILITY_UNAVAILABLE`, `WORKSPACE_NOT_FOUND`, `PARTIAL_APPLY` | **needs instrumentation** |
| Incomplete answers | count of responses carrying `truncated`, by route | **needs instrumentation** |
| Edit plans | prepared, applied, discarded, expired; documents changed; undo available | mostly in the plan store |
| Recent queries | the queries consumers issued, from a capped in-memory ring — shown, not counted, with a hide control | **needs instrumentation** |
| Logs | the daemon's structured, redacted log (ADR-0011) | yes |

**Refusals by reason is the panel this product actually wants.** Everything in this repository is built so
that an agent is told "I could not look" instead of "there is nothing" — the whole of ADR-0030 through
ADR-0034 is that argument. A histogram of refusals is that principle made visible, and it is the panel a
maintainer would look at first: a spike in `INDEX_NOT_READY` means projects are being searched while
indexing, a spike in `STALE_SYMBOL` means handles are outliving their documents.

**A symbol-handle panel was designed and dropped.** Relocation is the mechanism that keeps an agent honest
across an edit (ADR-0018), so it looked like the obvious health signal. Writing the counters showed why it
cannot be one *here*: the only outcomes a daemon sees are `STALE_SYMBOL` and `AMBIGUOUS_SYMBOL`, which are
already refusal codes in the histogram above, while a **successful** relocation happens inside an adapter
and is invisible from the daemon. The panel would have been permanently half-true. Making it whole needs
adapters to report their own relocation outcomes — a protocol change, to be decided on its own.

**Index state replaces "Index Health 98%".** ADR-0034 gave one true index fact per workspace. A percentage
has no source and no meaning here.

### Metrics are counters, and bounded

New instrumentation is counts, sums and percentiles over a rolling window — never a transcript. Bounded
by construction: fixed-size buckets per method and per error code, a windowed histogram for latency, no
per-request retention. The daemon already refuses to log file contents, replacement text or tokens
(ADR-0011); counting must not become a way around that.

### `Languages` per project is refused, not approximated

The adapter ships no language-specific knowledge, and that rule is why it serves four IDEs. Deriving a
project's languages from file extensions would smuggle that knowledge into the dashboard instead of the
adapter. The honest route is a capability where each adapter reports the `languageId`s **its own IDE**
assigns — a real feature with a scan cost, to be decided on its own.

### The daemon serves it read-only, on loopback, behind a single-use token

- A read-only HTTP surface bound to `127.0.0.1`/`::1`, refusing any request whose `Host` is not loopback.
- No state-changing route in v1. The mockup's `Open in IDE`, `Add Tool`, `Add Project` and
  `Check for Updates` are absent, not rendered inert.
- A single-use, short-lived launch token, exchanged by the page for an in-memory session token — not a
  cookie, not `localStorage`, both of which outlive the tab and the user's intent.
- **Started by `ide-bridge daemon --dashboard`, not by a separate `ide-bridge dashboard` command.** This
  ADR proposed the latter, and building it showed the cost: a second command has no channel to a running
  daemon except a new protocol method, which is the cross-language change this ADR already declined for
  the metrics. The flag needs none — the daemon that owns the port prints the one URL that opens it, on
  its own stdout, which is not an artifact that travels. A convenience command that attaches to a running
  daemon stays possible and stays unbuilt.
- Off unless asked for: a port nobody requested is a port nobody is watching. The flag is refused on the
  other CLI commands rather than ignored, because a flag silently accepted where it does nothing teaches
  the reader that it did something.
- No CORS headers, so no other page can read it.
- The routed methods — the ones that reach into an IDE and can open documents or prepare edits — are **not**
  exposed. Status, listing and metrics are enough for everything v1 shows.

### The counters travel on the daemon's own status, not behind a new method

A new admin method was the obvious shape and is the wrong trade here: the Kotlin `CatalogueCoverageTest`
compares the methods declared in the schemas against `APPLICATION_METHODS` exactly, so a new method name
makes a read-only local counter a **cross-language protocol change** — catalogue, role partitions and
types in two languages. An **optional** `metrics` object on the existing `bridge/getStatus` response
carries the same information for a schema edit, a fixture pass and a regeneration, and no Kotlin change
at all, because no method name is added. The CLI needed no change either: `ide-bridge status` already
prints that response.

Optional rather than required, deliberately: a daemon that keeps no counters omits the field instead of
reporting zeroes, which read exactly like an idle daemon.

One sub-decision worth naming. The refusal histogram's `code` is a **bounded string, not the canonical
`errorCode` enum**. It is a histogram key, not an error being reported, and a daemon that counted a code
its version does not recognize should show it rather than invalidate its whole status response over a
label.

## Consequences

- The dashboard becomes a control plane for this product rather than a shell for another one: ten panels,
  every number with a source, and the two that were percentages become states.
- Four panels need new instrumentation in the daemon. That is a real increment, and it is the one that
  makes the page worth opening twice.
- A new attack surface exists where there was none. It is minimised — read-only, loopback, single-use
  token, no CORS, no cookies, no routed methods — and it needs a security review before this ADR is
  accepted, not after.
- The tool window's dashboard button becomes possible, and stays **absent** until this is accepted: a
  button that opens nothing is what the rest of this session has been removing.
- The mockup's "Recent Semantic Searches" becomes recent **queries**, shown rather than counted, for the
  reasons and under the constraints stated below.

### Recent queries are shown, in memory, with a way to hide them

The first draft of this ADR recommended counting queries rather than displaying them, on the grounds that
the daemon redacts request payloads (ADR-0011). That reasoning was wrong, and the correction is the useful
part of it: **ADR-0011 governs what travels.** A log is written to disk, attached to a bug report,
collected by CI, read by someone else. A page bound to loopback with its `Host` checked, reached through a
single-use token, holding a capped buffer in memory, does not travel — and the only person who can read it
is the one whose IDE was searched and whose agent issued the query.

Utility settles the rest. "47 searches" says nothing; "the agent searched `getUserPassword` twelve times"
says what it is doing, which for a product whose subject *is* agent-to-IDE traffic is the observability
that matters most.

So the queries are shown, under four constraints:

- **Memory only**, a capped ring of the most recent queries, never written to disk.
- **Never in the structured log**, which keeps ADR-0011 exactly as it is.
- **A "hide queries" control on the page**, defaulting to visible. The one real exposure left is a
  screenshot or a shared screen — observed in this very session, when a screenshot of the IDE was pasted
  into a conversation — and that is answered by a switch, not by withholding the panel.
- **Retention stated on the page itself**, not only in this ADR.

## What this ADR still needs

**A security review of the HTTP surface** against AGENTS §4: bind, `Host` check, token lifetime and single
use, absence of CORS, the guarantee that no exposed route can change state, and the query buffer's lifetime
— including the fact that a memory dump is the one place it could still surface.

## Alternatives considered

### Ship the mockup as-is, with placeholder numbers

Rejected, and it is the alternative this whole session argues against: `842 memories` on a product with no
memories is the same defect as an empty symbol list presented as complete. A number with no source is a
lie with a nice font.

### Render the unsourced panels as "not connected"

The previous draft of this ADR, written before the owner confirmed there is no external backend. Rejected
once that was known: nine permanent apologies is not a design, and "not connected" implies a connection is
coming.

### A JCEF panel inside the IDE

No port, no token, no HTTP surface — genuinely better on security. Rejected for v1 because it shows one
IDE, and the work just completed made several IDEs and several projects the normal case; a dashboard that
cannot show the second one answers the wrong question. It would also need a JS↔Kotlin bridge duplicating
what the daemon already does.

### Reuse the WebSocket token in the browser

Rejected. That token is the daemon's authority, kept in a `0600` file a browser cannot read, and putting it
in a URL would write it into browser history. Hence a separate token whose only power is to start a
read-only session.

### Expose the routed methods to the page

Rejected for v1. Those routes open documents and prepare edits inside a live IDE. Putting them behind a
browser origin would make the dashboard the most powerful client in the system, for the sake of buttons
this ADR has already decided not to ship.
