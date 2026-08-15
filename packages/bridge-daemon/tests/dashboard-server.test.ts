import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DashboardServer } from "../src/dashboard/dashboard-server.js";

/**
 * The constraints that make a browser-reachable surface acceptable at all (ADR-0035).
 *
 * These are not tests that the happy path works — that is one line. They are the refusals, because this
 * is the first surface in the system a page can reach, and every one of them is a way the surface could
 * become something other than a local read-only view.
 */

const servers: DashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

async function start(
  snapshot: () => unknown = () => ({ ok: true }),
  now?: () => number,
): Promise<{ server: DashboardServer; endpoint: string; url: string }> {
  const server = new DashboardServer(now === undefined ? { snapshot } : { snapshot, now });
  servers.push(server);
  const { endpoint, url } = await server.start();
  return { server, endpoint, url };
}

async function open(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: string }).session;
}

describe("DashboardServer", () => {
  it("binds loopback only, and says so in the URL it hands back", async () => {
    const { endpoint } = await start();
    expect(endpoint.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("trades the launch token for a session, once", async () => {
    const { url } = await start();
    const session = await open(url);
    expect(session.length).toBeGreaterThan(20);

    // The URL carries the token, and a URL reaches shell history and browser history. One exchange.
    const replay = await fetch(url);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid-launch-token" });
  });

  it("refuses an expired launch token", async () => {
    let clock = 1_000;
    const { url } = await start(
      () => ({ ok: true }),
      () => clock,
    );
    clock += 61_000;

    const response = await fetch(url);
    expect(response.status).toBe(401);
  });

  it("refuses data without a session, and serves it with one", async () => {
    const { endpoint, url } = await start(() => ({ methods: [], refusals: [] }));

    const anonymous = await fetch(`${endpoint}/data`);
    expect(anonymous.status).toBe(401);

    const session = await open(url);
    const authorized = await fetch(`${endpoint}/data`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ methods: [], refusals: [] });
  });

  it("refuses a fabricated session token", async () => {
    const { endpoint } = await start();
    const response = await fetch(`${endpoint}/data`, {
      headers: {
        authorization: "Bearer ZmFrZS10b2tlbi13aXRoLWVub3VnaC1sZW5ndGgtdG8tcGFzcy1zaGFwZQ",
      },
    });
    expect(response.status).toBe(401);
  });

  it("refuses anything that is not a read", async () => {
    const { endpoint, url } = await start();
    const session = await open(url);

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(`${endpoint}/data`, {
        method,
        headers: { authorization: `Bearer ${session}` },
      });
      // Refused before the body is even considered: nothing here can change state, so a write is not
      // an unimplemented feature but a category error.
      expect(response.status).toBe(405);
    }
  });

  it("refuses a Host that is not loopback, which the bind alone does not stop", async () => {
    const { endpoint, url } = await start();
    const session = await open(url);
    const port = Number(new URL(endpoint).port);

    // Written with the low-level client on purpose: `fetch` treats `Host` as a forbidden header and
    // drops it silently, so the same test written with `fetch` sends the real host and proves nothing.
    // A DNS-rebinding page reaches this port through a name that resolves to 127.0.0.1 — the socket is
    // local, and only the `Host` header shows what the page thought it was talking to.
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/data",
          method: "GET",
          headers: { authorization: `Bearer ${session}`, host: "dashboard.example.com" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });

    expect(status).toBe(421);
  });

  it("sets no CORS header and no cookie", async () => {
    const { endpoint, url } = await start();
    const session = await open(url);
    const response = await fetch(`${endpoint}/data`, {
      headers: { authorization: `Bearer ${session}` },
    });

    // Another origin must not be able to read this even if it learns the port.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("closes without leaving the port open", async () => {
    const { server, endpoint } = await start();
    await server.close();
    await expect(fetch(`${endpoint}/data`)).rejects.toThrow();
  });
});
