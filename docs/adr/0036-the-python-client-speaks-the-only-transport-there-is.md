# ADR-0036: The Python client speaks the only transport there is

- Status: accepted
- Date: 2026-08-09
- Related: [ADR-0025](0025-cross-language-uri-vectors.md), [ADR-0029](0029-serena-is-extended-by-runtime-composition.md)

## Context

The Serena integration needs to call the daemon. The question raised was whether it should open a
WebSocket at all, or whether a server-sent event stream would do — an `EventSource` is simpler, has
no framing to get wrong, and reconnects on its own.

## Measurement

The daemon's RPC surface was read rather than recalled:

- `LoopbackWebSocketServer` is the only RPC transport, bound to `path: "/rpc"`.
- No `text/event-stream` appears anywhere in the daemon. There is no SSE endpoint and no HTTP
  JSON-RPC endpoint.
- The one plain-HTTP server, `dashboard-server.ts`, is the read-only dashboard of ADR-0035. It
  serves no methods.
- The published endpoint already carries its path — `ws://127.0.0.1:<port>/rpc` — so a client uses
  discovery's value as given rather than assembling one.

Serena itself ships no websocket library: `websockets`, `websocket-client` and `aiohttp` are all
absent from its environment; only `httpx` is present, which does not speak WebSocket unaided.

## Decision

**The Python client connects with `websockets`, using its synchronous client.**

Server-sent events were rejected on four grounds, in order of weight.

**An `EventSource` cannot send.** It is receive-only. Every IDEBP call is a request expecting a
response, so SSE would need a second channel to carry requests — and the daemon exposes none. The
choice was never "SSE instead of WebSocket" but "SSE plus a server transport that does not exist".

**The token would move somewhere worse.** Authentication travels inside the handshake frame today.
`EventSource` sets no headers, so a token would end up in a query string, which the project's
security rules forbid for a credential.

**A session is bound to its connection.** The handshake establishes one on that socket. Splitting
into an SSE downlink and a POST uplink would mean correlating a session across two channels — a
second, Python-only state machine holding one of the protocol's rules, which is the drift ADR-0025
answers by making both languages prove the same rule against shared vectors.

**The shape is wrong.** This client is deliberately one connection per operation: connect,
handshake, ask once, close. SSE is built for a long-lived server-to-client feed.

The synchronous client is chosen over the async one because a Serena tool call is a blocking
operation; an async-only client would pull an event loop into a code path with no use for one.

## Consequences

- One dependency is added, `websockets>=13`. It is pure Python with no compiled extension.
- Frames that do not bear the request's id are skipped rather than taken as the answer. The daemon
  may send a consumer notifications at any time, and treating the next frame as the response would
  attribute one message's contents to another request — proven by isolated mutation, which fails
  exactly the correlation test and nothing else.
- A refused connection is reported as an **absent daemon**, not a failed request. No IDE running is
  an ordinary state of this system, and the distinction is what lets a tool say "start your IDE".
- The transport is verified against the **real daemon**, not only the loopback stand-in the unit
  tests use. A stand-in accepts whatever it is sent and so cannot judge a frame. Against a real
  `IDEBPDaemonServer`: the handshake was accepted, and `document/getSymbols` was refused with
  `WORKSPACE_NOT_FOUND` — the correct answer when no adapter is connected, and only reachable by a
  request that passed authentication, schema validation and routing.
- That run also caught what the stand-in could not: `workspaceId` is constrained to
  `^ws_[A-Za-z0-9_-]+$`, and the first two probes were refused `INVALID_REQUEST` for supplying a
  UUID. Callers must build the identifier, not invent one.

**Where SSE would be the right tool.** Pushing IDE state to the JUNON dashboard — diagnostics
changing, indexing progress — is a long-lived, one-way, server-to-client feed served by an HTTP
server that already exists and carries no credential in its URL. If that need arrives, this decision
does not stand against it: SSE is wrong for calling methods, not wrong in general.
