import type { IDEBPSessionRole } from "@ide-bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { IDEBPDaemonServer } from "../src/daemon-server.js";
import { generateAuthenticationToken } from "../src/security/authentication-token.js";

/**
 * That the counters are fed by real traffic, not only by their own unit tests.
 *
 * `MetricsRegistry` is tested in isolation elsewhere; this drives a real daemon over a real socket and
 * asserts the four hooks fire — a call with a duration, a refusal with its code, an incomplete answer,
 * and the query text. Instrumentation that is never called is the failure mode a registry test cannot
 * see (ADR-0035).
 */

const servers: IDEBPDaemonServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

class Peer {
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(message: unknown) => void> = [];
  sessionId: string | undefined;

  constructor(readonly socket: WebSocket) {
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as unknown;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(message);
      else waiter(message);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async next(): Promise<unknown> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return queued;
    return await new Promise<unknown>((resolve) => this.#waiters.push(resolve));
  }
}

async function connect(
  endpoint: string,
  token: string,
  role: IDEBPSessionRole,
  suffix: string,
): Promise<Peer> {
  const socket = new WebSocket(endpoint);
  sockets.push(socket);
  await new Promise<undefined>((resolve, reject) => {
    socket.once("open", () => resolve(undefined));
    socket.once("error", reject);
  });
  const peer = new Peer(socket);
  peer.send({
    jsonrpc: "2.0",
    id: `handshake-${suffix}`,
    method: "bridge/handshake",
    params: {
      authentication: { method: "token", token },
      role,
      protocol: { minimum: "0.1.0", maximum: "0.1.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
      clientInfo: { name: `${role}-metrics-test`, version: "0.1.0" },
    },
  });
  const handshake = (await peer.next()) as { result?: { sessionId?: string } };
  peer.sessionId = handshake.result?.sessionId;
  return peer;
}

const WORKSPACE = {
  workspaceId: "ws_metrics_1",
  adapterId: "adapter_metrics_1",
  name: "fixture",
  roots: [{ rootId: "root_metrics_1", name: "fixture", uri: "file:///workspace/fixture/" }],
  workspaceEpoch: 1,
  trust: "trusted",
} as const;

/** The registration shape the router's own tests use, rather than one invented here. */
function registerParams() {
  return {
    adapterId: WORKSPACE.adapterId,
    name: "ide-bridge-metrics-test",
    version: "0.1.0",
    ideKind: "vscode",
    ideVersion: "1.125.0",
    positionEncodings: ["utf-16"],
    capabilities: {
      "document/read": { support: "native", guarantee: "semantic" },
      "workspace/searchSymbols": { support: "native" },
    },
    workspaces: [WORKSPACE],
  } as const;
}

async function startDaemon(): Promise<{
  server: IDEBPDaemonServer;
  token: string;
  endpoint: string;
}> {
  const token = generateAuthenticationToken();
  const server = new IDEBPDaemonServer({ expectedToken: token });
  servers.push(server);
  return { server, token, endpoint: await server.start() };
}

describe("metrics hooks", () => {
  it("counts a refused call, with its code, from real traffic", async () => {
    const { server, token, endpoint } = await startDaemon();
    const consumer = await connect(endpoint, token, "consumer", "c1");

    consumer.send({
      jsonrpc: "2.0",
      id: "search-1",
      method: "workspace/searchSymbols",
      params: { workspaceId: "ws_nobody_registered", query: "anything", limit: 10 },
    });
    await consumer.next();

    const snapshot = server.router.metrics.snapshot();
    const activity = snapshot.methods.find((entry) => entry.method === "workspace/searchSymbols");
    expect(activity?.calls).toBe(1);
    // A refusal is a served request: counting only successes would understate the load a daemon is
    // actually carrying.
    expect(snapshot.refusals.map((entry) => entry.code)).toContain("WORKSPACE_NOT_FOUND");
    // Attributed to the method too, not only counted by code: the per-method column was empty for
    // every daemon-side refusal until the method was threaded through, and an empty column reads as
    // "this method is never refused".
    expect(activity?.refusals).toBe(1);
  });

  it("records the query text and the incompleteness an adapter reports", async () => {
    const { server, token, endpoint } = await startDaemon();
    const adapter = await connect(endpoint, token, "adapter", "a1");
    adapter.send({
      jsonrpc: "2.0",
      id: "register-1",
      method: "ide/register",
      params: registerParams(),
    });
    await adapter.next();

    const consumer = await connect(endpoint, token, "consumer", "c2");
    consumer.send({
      jsonrpc: "2.0",
      id: "search-2",
      method: "workspace/searchSymbols",
      params: {
        workspaceId: WORKSPACE.workspaceId,
        query: "how is token refresh handled?",
        limit: 10,
      },
    });

    // The daemon forwards to the adapter, which answers an empty-but-truncated result — legal for this
    // route (ADR-0031) and exactly the shape the "incomplete answers" panel is for.
    const forwarded = (await adapter.next()) as { id: unknown };
    adapter.send({
      jsonrpc: "2.0",
      id: forwarded.id,
      result: { symbols: [], truncated: true },
    });
    await consumer.next();

    const snapshot = server.router.metrics.snapshot();
    expect(snapshot.queries[0]?.query).toBe("how is token refresh handled?");
    expect(snapshot.queries[0]?.method).toBe("workspace/searchSymbols");
    expect(snapshot.incomplete).toEqual([{ method: "workspace/searchSymbols", count: 1 }]);
    // And the adapter's own refusal codes are not invented here: this answer was a result.
    expect(snapshot.refusals).toEqual([]);
  });

  it("carries the counters on the daemon's own status, readable by a consumer", async () => {
    const { token, endpoint } = await startDaemon();
    const consumer = await connect(endpoint, token, "consumer", "c4");

    // One refused call to have something to report, then ask the daemon about itself.
    consumer.send({
      jsonrpc: "2.0",
      id: "search-4",
      method: "workspace/searchSymbols",
      params: { workspaceId: "ws_nobody_registered", query: "kept in the ring", limit: 10 },
    });
    await consumer.next();

    consumer.send({ jsonrpc: "2.0", id: "status-1", method: "bridge/getStatus", params: {} });
    const status = (await consumer.next()) as {
      result?: {
        metrics?: {
          methods?: { method: string; calls: number }[];
          refusals?: { code: string; count: number }[];
          queryRingCapacity?: number;
        };
      };
    };

    // The point of exposing it here rather than behind a new method: this response already exists and
    // already crosses the wire, so the counters travel without a new method name (ADR-0035).
    expect(status.result?.metrics?.refusals).toEqual([{ code: "WORKSPACE_NOT_FOUND", count: 1 }]);
    expect(
      status.result?.metrics?.methods?.find((entry) => entry.method === "workspace/searchSymbols")
        ?.calls,
    ).toBe(1);
    expect(status.result?.metrics?.queryRingCapacity).toBeGreaterThan(0);
  });

  it("counts an adapter's refusal against the method it refused", async () => {
    const { server, token, endpoint } = await startDaemon();
    const adapter = await connect(endpoint, token, "adapter", "a2");
    adapter.send({
      jsonrpc: "2.0",
      id: "register-2",
      method: "ide/register",
      params: registerParams(),
    });
    await adapter.next();

    const consumer = await connect(endpoint, token, "consumer", "c3");
    consumer.send({
      jsonrpc: "2.0",
      id: "search-3",
      method: "workspace/searchSymbols",
      params: { workspaceId: WORKSPACE.workspaceId, query: "anything", limit: 10 },
    });
    const forwarded = (await adapter.next()) as { id: unknown };
    // The refusal this whole increment exists to make visible: the IDE is still indexing.
    adapter.send({
      jsonrpc: "2.0",
      id: forwarded.id,
      // -32001 is the numeric code the wire schema permits for a normalized refusal; the string in
      // `data.code` is the one that carries meaning, and the one the panel counts.
      error: {
        code: -32001,
        message: "Index not ready",
        data: { code: "INDEX_NOT_READY", retryable: true },
      },
    });
    await consumer.next();

    const snapshot = server.router.metrics.snapshot();
    expect(snapshot.refusals).toEqual([{ code: "INDEX_NOT_READY", count: 1 }]);
    expect(
      snapshot.methods.find((entry) => entry.method === "workspace/searchSymbols")?.refusals,
    ).toBe(1);
  });
});
