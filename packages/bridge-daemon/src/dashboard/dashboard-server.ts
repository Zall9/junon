import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  authenticationTokensEqual,
  generateAuthenticationToken,
} from "../security/authentication-token.js";

/**
 * A read-only local surface for a person to look at the daemon (ADR-0035).
 *
 * Everything about this is narrowed on purpose, because it is the first surface in this system a
 * **browser** can reach — a client that cannot read the `0600` discovery file and that runs content its
 * user did not write. The WebSocket transport's own constraints are reused rather than reinvented: the
 * same loopback bind, the same 256-bit CSPRNG token generator, the same constant-time comparison.
 *
 * What it does not do, each for a stated reason:
 *
 * - **No state can change.** Only GET is answered; every route reads. The routed methods that reach into
 *   an IDE and can open documents or prepare edits are not exposed at all, so a page cannot become the
 *   most powerful client in the system.
 * - **No CORS headers**, so no other origin can read a response even if it guesses the port.
 * - **No cookie and no `Set-Cookie`.** The session token lives in the page's memory and dies with the
 *   tab; a cookie would outlive both the tab and the user's intent.
 * - **The launch token is single-use.** It appears in a URL, and a URL reaches shell history, terminal
 *   scrollback and the browser's own history, so it buys exactly one exchange for a session token.
 * - **`Host` must be loopback.** Binding to `127.0.0.1` already refuses remote sockets; checking `Host`
 *   refuses a DNS-rebinding page that reaches the port through a name that resolves here.
 */

/** How long an unused launch token stays valid. Long enough to open a browser, not to be filed away. */
const LAUNCH_TOKEN_TTL_MS = 60_000;

/** How long a session token lives without being used. */
const SESSION_TTL_MS = 60 * 60_000;

export interface DashboardData {
  /** Whatever the reader is allowed to see. Built by the caller, so this file knows no protocol. */
  readonly snapshot: () => unknown;
}

export interface DashboardServerOptions extends DashboardData {
  readonly now?: () => number;
}

export class DashboardServer {
  #server: Server | undefined;
  #launchToken: string | undefined;
  #launchTokenExpiresAt = 0;
  #sessions = new Map<string, number>();
  readonly #snapshot: () => unknown;
  readonly #now: () => number;

  constructor(options: DashboardServerOptions) {
    this.#snapshot = options.snapshot;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Starts the surface and returns the one URL that can open it.
   *
   * The token is returned rather than logged: the daemon's structured log is an artifact that travels
   * (ADR-0011), and a launch token in it would travel with it.
   */
  async start(): Promise<{ endpoint: string; url: string }> {
    if (this.#server !== undefined) throw new Error("Dashboard server already started");
    const server = createServer((request, response) => {
      this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // The same bind as the WebSocket transport: loopback only, ephemeral port. A dashboard reachable
      // from another machine would be a remote control panel for someone else's IDE.
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    this.#launchToken = generateAuthenticationToken();
    this.#launchTokenExpiresAt = this.#now() + LAUNCH_TOKEN_TTL_MS;
    return { endpoint, url: `${endpoint}/open?t=${this.#launchToken}` };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#launchToken = undefined;
    this.#sessions.clear();
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  get endpoint(): string | undefined {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string") return undefined;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    // A page cannot change anything here, so anything but a read is refused before it is parsed.
    if (request.method !== "GET") {
      this.#refuse(response, 405, "read-only");
      return;
    }
    if (!isLoopbackHost(request.headers.host)) {
      // Refuses a page that reached this port through a name resolving to 127.0.0.1 — the bind alone
      // does not stop DNS rebinding.
      this.#refuse(response, 421, "loopback-only");
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/open") {
      this.#exchange(url.searchParams.get("t"), response);
      return;
    }
    if (url.pathname === "/data") {
      this.#serveData(request, response);
      return;
    }
    this.#refuse(response, 404, "not-found");
  }

  /** Trades the single-use launch token for a session token, then forgets the launch token. */
  #exchange(supplied: string | null, response: ServerResponse): void {
    const launchToken = this.#launchToken;
    const expired = this.#now() > this.#launchTokenExpiresAt;
    if (launchToken === undefined || expired || !authenticationTokensEqual(launchToken, supplied)) {
      this.#refuse(response, 401, "invalid-launch-token");
      return;
    }
    // Consumed whether or not the page ever comes back: a second use would mean the URL was replayed
    // from somewhere it had been recorded.
    this.#launchToken = undefined;
    const session = generateAuthenticationToken();
    this.#sessions.set(session, this.#now() + SESSION_TTL_MS);
    this.#json(response, 200, { session });
  }

  #serveData(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers.authorization;
    const supplied = typeof header === "string" ? header.replace(/^Bearer /u, "") : undefined;
    if (!this.#sessionValid(supplied)) {
      this.#refuse(response, 401, "invalid-session");
      return;
    }
    this.#json(response, 200, this.#snapshot());
  }

  #sessionValid(supplied: string | undefined): boolean {
    if (supplied === undefined) return false;
    const now = this.#now();
    for (const [token, expiresAt] of [...this.#sessions.entries()]) {
      if (expiresAt <= now) this.#sessions.delete(token);
    }
    for (const [token, expiresAt] of this.#sessions.entries()) {
      // Compared against every live session in constant time rather than looked up by key: a map
      // lookup on attacker-supplied text is a timing signal about which prefixes exist.
      if (expiresAt > now && authenticationTokensEqual(token, supplied)) return true;
    }
    return false;
  }

  #refuse(response: ServerResponse, status: number, reason: string): void {
    this.#json(response, status, { error: reason });
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      // No CORS header of any kind: another origin must not be able to read this even knowing the port.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Nothing here embeds or is embedded, and a page that cannot be framed cannot be clickjacked.
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    response.end(payload);
  }
}

/** Whether a `Host` header names this machine's loopback interface. */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const withoutPort = host.replace(/:\d+$/u, "");
  return withoutPort === "127.0.0.1" || withoutPort === "localhost" || withoutPort === "[::1]";
}
