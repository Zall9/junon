# packages/bridge-daemon/src/dashboard/

## Responsibility

Read-only loopback HTTP server exposing daemon state to a local browser (ADR-0035). The first surface in this system a browser can reach — a client that cannot read the `0600` discovery file and that runs content its user did not write. The WebSocket transport's own constraints are reused rather than reinvented: same loopback bind, same 256-bit CSPRNG token generator, same constant-time comparison.

## Design

- **Read-only by construction** (`dashboard-server.ts:19-21`): Only GET is answered; every route reads. The routed methods that reach into an IDE and can open documents or prepare edits are not exposed at all, so a page cannot become the most powerful client in the system.
- **No CORS headers** (`dashboard-server.ts:22`): No other origin can read a response even if it guesses the port.
- **No cookie, no `Set-Cookie`** (`dashboard-server.ts:23-24`): The session token lives in the page's memory and dies with the tab; a cookie would outlive both the tab and the user's intent.
- **Single-use launch token** (`dashboard-server.ts:25-26`): The launch token appears in a URL, and a URL reaches shell history, terminal scrollback and the browser's own history, so it buys exactly one exchange for a session token.
- **`Host` must be loopback** (`dashboard-server.ts:27-28`): Binding to `127.0.0.1` already refuses remote sockets; checking `Host` refuses a DNS-rebinding page that reaches the port through a name that resolves here.
- **Constant-time session comparison** (`dashboard-server.ts:156-168`): Session tokens are compared against every live session in constant time via `authenticationTokensEqual`, never looked up by key — a map lookup on attacker-supplied text is a timing signal about which prefixes exist.
- **CSP `default-src 'none'; frame-ancestors 'none'`** (`dashboard-server.ts:182`): Nothing here embeds or is embedded; a page that cannot be framed cannot be clickjacked.
- **`now` injectable for testing** (`dashboard-server.ts:42-44`): `DashboardServerOptions.now?: () => number` defaults to `Date.now()`.

## Key Types

- `DashboardData` (`dashboard-server.ts:37-40`): `readonly snapshot: () => unknown` — whatever the reader is allowed to see. Built by the caller, so this file knows no protocol.
- `DashboardServerOptions` (`dashboard-server.ts:42-44`): Extends `DashboardData` with `readonly now?: () => number`.
- `DashboardServer` (`dashboard-server.ts:46`): The server class. Private fields:
  - `#server: Server | undefined` (`:47`) — Node.js `http` server instance.
  - `#launchToken: string | undefined` (`:48`) — single-use token for initial browser open.
  - `#launchTokenExpiresAt = 0` (`:49`) — expiry timestamp for the launch token.
  - `#sessions = new Map<string, number>()` (`:50`) — session token → expiry timestamp.
  - `readonly #snapshot: () => unknown` (`:51`) — the data source, injected at construction.
  - `readonly #now: () => number` (`:52`) — clock, injectable for testing.
- Constants: `LAUNCH_TOKEN_TTL_MS = 60_000` (`:32`), `SESSION_TTL_MS = 60 * 60_000` (`:35`).

## Key Functions

- `start()` (`dashboard-server.ts:65-84`): Binds `127.0.0.1:0` (loopback, ephemeral port), generates a 60s launch token, returns `{ endpoint, url }` where `url` includes `/open?t=<token>`. Throws if already started.
- `close()` (`:86-97`): Stops the HTTP server, clears the launch token and all sessions.
- `endpoint` getter (`:99-103`): Returns `http://127.0.0.1:<port>` or `undefined` if not started.
- `#handle` (`:105-128`): GET-only router. Non-GET → 405; non-loopback Host → 421; `/open` → `#exchange`; `/data` → `#serveData`; else → 404.
- `#exchange` (`:131-144`): Trades the single-use launch token for a session token, then forgets the launch token. Returns `{ session }` as JSON. Launch token is consumed even on failed exchange.
- `#serveData` (`:146-154`): Requires `Authorization: Bearer <session>` header. Validates via `#sessionValid`, then returns `this.#snapshot()` as JSON.
- `#sessionValid` (`:156-168`): Lazily cleans expired sessions, then constant-time compares the supplied token against all live sessions. Returns `false` if no match.
- `#json` (`:174-185`): Writes JSON response with security headers: `content-type: application/json`, `cache-control: no-store`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; frame-ancestors 'none'`.
- `isLoopbackHost` (`:189-193`): Whether a `Host` header names `127.0.0.1`, `localhost`, or `[::1]` (port stripped first).

## Endpoints

| Method  | Path              | Auth                              | Response                         |
| ------- | ----------------- | --------------------------------- | -------------------------------- |
| GET     | `/open?t=<token>` | launch token (query param)        | `{ session: string }`            |
| GET     | `/data`           | `Authorization: Bearer <session>` | snapshot JSON                    |
| non-GET | any               | —                                 | `405 { error: "read-only" }`     |
| GET     | non-loopback Host | —                                 | `421 { error: "loopback-only" }` |
| GET     | unknown path      | —                                 | `404 { error: "not-found" }`     |

## Flow

1. Daemon calls `startDashboard()` on `IDEBPDaemonServer` → constructs `DashboardServer` with a `snapshot` function → `start()` returns `{ endpoint, url }`.
2. URL with launch token is written to stdout (not structured log — ADR-0011).
3. Browser opens `/open?t=<token>` → `#exchange` validates and consumes the launch token → returns `{ session }`.
4. Browser uses session token in `Authorization: Bearer <session>` header for subsequent `/data` requests → `#serveData` validates session → returns snapshot JSON.
5. Session tokens expire after `SESSION_TTL_MS` (1 hour) of inactivity; cleaned lazily on each `/data` request.

## Integration

- **Consumed by**: `IDEBPDaemonServer` (`daemon-server.ts:115-127`) constructs and owns the dashboard via `startDashboard()`. The snapshot is assembled from `router.status()` (includes metrics via `mutableMetrics`), `registry.listAdapters()`, and `registry.listWorkspaces()`.
- **Depends on**: `../security/authentication-token.js` for `generateAuthenticationToken` and `authenticationTokensEqual` (256-bit CSPRNG tokens, constant-time comparison), Node.js `http` module (`createServer`).
- **External boundaries**: Listens on `127.0.0.1:0` (loopback, ephemeral port). No CORS, no cookies, no `Set-Cookie`. GET only.

## Common Gotchas

- **Launch token consumed even on failed exchange** (`:138-140`): A second use would mean the URL was replayed from somewhere it had been recorded. The token is cleared before the session is created.
- **Session comparison is O(n) by design** (`:156-168`): Iterates all sessions for constant-time comparison rather than a map lookup, to avoid leaking which token prefixes exist via timing.
- **Expired sessions cleaned lazily** (`:159-161`): No background sweep; expired entries are deleted during `#sessionValid` iteration.
- **URL returned not logged** (`:63-64`, ADR-0011): The daemon's structured log is an artifact that travels; a launch token in it would travel with it.
- **`now` injectable for testing** (`:42-44`): Defaults to `Date.now()` but accepts a custom clock for deterministic expiry tests.
