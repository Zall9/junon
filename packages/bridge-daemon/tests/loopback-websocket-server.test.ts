import type { BridgeHandshakeRequest } from "@ide-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { generateAuthenticationToken } from "../src/security/authentication-token.js";
import type { HandshakeRejectionReason } from "../src/observability/structured-logger.js";
import { LoopbackWebSocketServer } from "../src/transport/loopback-websocket-server.js";
import type { AuthenticatedTransportConnection } from "../src/transport/transport.js";
import type { SessionCloseReason } from "../src/transport/transport.js";

const servers: LoopbackWebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function handshakeRequest(token: string, id: string | number = "handshake-1") {
  return {
    jsonrpc: "2.0",
    id,
    method: "bridge/handshake",
    params: {
      authentication: { method: "token", token },
      role: "consumer",
      protocol: { minimum: "0.1.0", maximum: "0.1.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
      clientInfo: { name: "websocket-test", version: "0.1.0" },
    },
  } satisfies BridgeHandshakeRequest;
}

async function startServer(
  expectedToken: string,
  options: {
    maxMessageBytes?: number;
    handshakeTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    maxMissedHeartbeats?: number;
    onMessage?: (message: unknown) => void;
    onSessionActivity?: (connection: AuthenticatedTransportConnection) => void;
    onSessionClosed?: (
      connection: AuthenticatedTransportConnection,
      reason: SessionCloseReason,
    ) => void;
    onHandshakeRejected?: (reason: HandshakeRejectionReason) => void;
    handler?: (
      connection: AuthenticatedTransportConnection,
      message: unknown,
    ) => void | Promise<void>;
  } = {},
): Promise<{ server: LoopbackWebSocketServer; endpoint: string }> {
  const server = new LoopbackWebSocketServer({
    expectedToken,
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.maxMissedHeartbeats === undefined
      ? {}
      : { maxMissedHeartbeats: options.maxMissedHeartbeats }),
    ...(options.onSessionActivity === undefined
      ? {}
      : { onSessionActivity: options.onSessionActivity }),
    ...(options.onSessionClosed === undefined ? {} : { onSessionClosed: options.onSessionClosed }),
    ...(options.onHandshakeRejected === undefined
      ? {}
      : { onHandshakeRejected: options.onHandshakeRejected }),
    onAuthenticatedMessage:
      options.handler ?? ((_connection, message) => options.onMessage?.(message)),
  });
  servers.push(server);
  return { server, endpoint: await server.start() };
}

async function connect(endpoint: string, autoPong = true): Promise<WebSocket> {
  const socket = new WebSocket(endpoint, { autoPong });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextJsonMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("loopback WebSocket handshake boundary", () => {
  it("binds only to IPv4 loopback on the fixed /rpc path", async () => {
    const { server, endpoint } = await startServer(generateAuthenticationToken());
    const url = new URL(endpoint);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/rpc");
    expect(Number(url.port)).toBeGreaterThan(0);

    url.pathname = "/other";
    await expect(connect(url.toString())).rejects.toThrow("Unexpected server response");
    expect(server.sessionCount).toBe(0);
  });

  it("establishes and removes a session around a valid handshake", async () => {
    const token = generateAuthenticationToken();
    const { server, endpoint } = await startServer(token);
    const socket = await connect(endpoint);
    const responsePromise = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));

    const response = await responsePromise;
    expect(response).toMatchObject({
      id: "handshake-1",
      result: { role: "consumer", protocolVersion: "0.1.0" },
    });
    await vi.waitFor(() => expect(server.sessionCount).toBe(1));
    const sessionSnapshot = server.sessions[0]!;
    sessionSnapshot.clientName = "mutated-outside-server";
    expect(server.sessions[0]?.clientName).toBe("websocket-test");

    const closed = nextClose(socket);
    socket.close();
    await closed;
    await vi.waitFor(() => expect(server.sessionCount).toBe(0));
  });

  it("keeps a quiet authenticated session alive through automatic pong frames", async () => {
    const token = generateAuthenticationToken();
    const activity = vi.fn();
    const { server, endpoint } = await startServer(token, {
      heartbeatIntervalMs: 60_000,
      maxMissedHeartbeats: 1,
      onSessionActivity: activity,
    });
    const socket = await connect(endpoint);
    const response = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await response;
    await vi.waitFor(() => expect(server.sessionCount).toBe(1));

    for (let index = 0; index < 3; index += 1) {
      const previousActivity = activity.mock.calls.length;
      server.sweepSessions();
      await vi.waitFor(() => expect(activity.mock.calls.length).toBeGreaterThan(previousActivity));
      expect(server.sessionCount).toBe(1);
    }
    socket.terminate();
  });

  it("expires only an authenticated peer that misses complete pong windows", async () => {
    const token = generateAuthenticationToken();
    const closures: SessionCloseReason[] = [];
    const { server, endpoint } = await startServer(token, {
      heartbeatIntervalMs: 60_000,
      maxMissedHeartbeats: 2,
      onSessionClosed: (_connection, reason) => closures.push(reason),
    });
    const socket = await connect(endpoint, false);
    const response = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await response;
    await vi.waitFor(() => expect(server.sessionCount).toBe(1));

    server.sweepSessions();
    server.sweepSessions();
    const closed = nextClose(socket);
    server.sweepSessions();
    await expect(closed).resolves.toEqual({ code: 1001, reason: "Session expired" });
    await vi.waitFor(() => expect(server.sessionCount).toBe(0));
    expect(closures).toEqual(["session-expired"]);
  });

  it("treats authenticated application traffic as heartbeat activity", async () => {
    const token = generateAuthenticationToken();
    const onMessage = vi.fn();
    const { server, endpoint } = await startServer(token, {
      heartbeatIntervalMs: 60_000,
      maxMissedHeartbeats: 1,
      onMessage,
    });
    const socket = await connect(endpoint, false);
    const response = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await response;
    await vi.waitFor(() => expect(server.sessionCount).toBe(1));

    server.sweepSessions();
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "status", method: "bridge/getStatus" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    server.sweepSessions();
    expect(server.sessionCount).toBe(1);
    socket.terminate();
  });

  it("classifies a normal authenticated peer close as shutdown", async () => {
    const token = generateAuthenticationToken();
    const closures: SessionCloseReason[] = [];
    const { endpoint } = await startServer(token, {
      onSessionClosed: (_connection, reason) => closures.push(reason),
    });
    const socket = await connect(endpoint);
    const response = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await response;

    const closed = nextClose(socket);
    socket.close(1000, "client shutdown");
    await closed;
    await vi.waitFor(() => expect(closures).toEqual(["shutdown"]));
  });

  it("rejects heartbeat configurations that could create unsafe timer behavior", () => {
    const base = {
      expectedToken: generateAuthenticationToken(),
      onAuthenticatedMessage: () => undefined,
    };
    expect(() => new LoopbackWebSocketServer({ ...base, heartbeatIntervalMs: 999 })).toThrow(
      "Heartbeat limits are invalid",
    );
    expect(() => new LoopbackWebSocketServer({ ...base, heartbeatIntervalMs: 60_001 })).toThrow(
      "Heartbeat limits are invalid",
    );
    expect(() => new LoopbackWebSocketServer({ ...base, maxMissedHeartbeats: 0 })).toThrow(
      "Heartbeat limits are invalid",
    );
    expect(() => new LoopbackWebSocketServer({ ...base, maxMissedHeartbeats: 11 })).toThrow(
      "Heartbeat limits are invalid",
    );
  });

  it("rejects a non-handshake first message, sends one safe error, and closes", async () => {
    const token = generateAuthenticationToken();
    const { server, endpoint } = await startServer(token);
    const socket = await connect(endpoint);
    let messages = 0;
    socket.on("message", () => {
      messages += 1;
    });
    const responsePromise = nextJsonMessage(socket);
    const closePromise = nextClose(socket);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ide/register", params: {} }));

    await expect(responsePromise).resolves.toMatchObject({
      id: 7,
      error: { code: -32600, data: { code: "INVALID_REQUEST", retryable: false } },
    });
    await expect(closePromise).resolves.toMatchObject({ code: 1008 });
    expect(messages).toBe(1);
    expect(server.sessionCount).toBe(0);
  });

  it("uses the same generic failure for a wrong token and never echoes either token", async () => {
    const expectedToken = generateAuthenticationToken();
    const suppliedToken = generateAuthenticationToken();
    const onHandshakeRejected = vi.fn();
    const { server, endpoint } = await startServer(expectedToken, { onHandshakeRejected });
    const socket = await connect(endpoint);
    const responsePromise = nextJsonMessage(socket);
    const closePromise = nextClose(socket);
    socket.send(JSON.stringify(handshakeRequest(suppliedToken)));

    const response = await responsePromise;
    expect(response).toMatchObject({
      error: { code: -32001, message: "Authentication failed" },
    });
    expect(JSON.stringify(response)).not.toContain(expectedToken);
    expect(JSON.stringify(response)).not.toContain(suppliedToken);
    await closePromise;
    expect(onHandshakeRejected).toHaveBeenCalledExactlyOnceWith("authentication-failed");
    expect(server.sessionCount).toBe(0);
  });

  it("rejects an oversized first message before creating a session", async () => {
    const token = generateAuthenticationToken();
    const { server, endpoint } = await startServer(token, { maxMessageBytes: 1024 });
    const socket = await connect(endpoint);
    const closePromise = nextClose(socket);
    socket.send(JSON.stringify({ value: "x".repeat(2048) }));

    await expect(closePromise).resolves.toMatchObject({ code: 1009 });
    expect(server.sessionCount).toBe(0);
  });

  it("expires an idle unauthenticated connection", async () => {
    const { server, endpoint } = await startServer(generateAuthenticationToken(), {
      handshakeTimeoutMs: 25,
    });
    const socket = await connect(endpoint);

    await expect(nextClose(socket)).resolves.toMatchObject({
      code: 1008,
      reason: "Handshake timeout",
    });
    expect(server.sessionCount).toBe(0);
  });

  it("rejects a second handshake without replacing the authenticated session", async () => {
    const token = generateAuthenticationToken();
    const { server, endpoint } = await startServer(token);
    const socket = await connect(endpoint);
    const firstResponse = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token, "first")));
    await firstResponse;
    await vi.waitFor(() => expect(server.sessionCount).toBe(1));

    const secondResponse = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token, "second")));
    await expect(secondResponse).resolves.toMatchObject({
      id: "second",
      error: { code: -32600, data: { code: "INVALID_REQUEST" } },
    });
    expect(server.sessionCount).toBe(1);

    socket.terminate();
  });

  it("does not dispatch queued application messages after a rejected handshake", async () => {
    const expectedToken = generateAuthenticationToken();
    const suppliedToken = generateAuthenticationToken();
    const onMessage = vi.fn();
    const { server, endpoint } = await startServer(expectedToken, { onMessage });
    const socket = await connect(endpoint);

    const closePromise = nextClose(socket);
    socket.send(JSON.stringify(handshakeRequest(suppliedToken)));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "bridge/getStatus", params: {} }));
    await closePromise;
    expect(onMessage).not.toHaveBeenCalled();
    expect(server.sessionCount).toBe(0);
  });

  it("contains dispatcher failures to the affected authenticated connection", async () => {
    const token = generateAuthenticationToken();
    const { endpoint } = await startServer(token, {
      onMessage: () => {
        throw new Error("dispatcher failure");
      },
    });
    const socket = await connect(endpoint);
    const handshakeResponse = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await handshakeResponse;

    const closePromise = nextClose(socket);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "bridge/getStatus" }));
    await expect(closePromise).resolves.toMatchObject({
      code: 1011,
      reason: "Message dispatcher failed",
    });
  });

  it("lets the dispatcher reply through the transport abstraction", async () => {
    const token = generateAuthenticationToken();
    const { endpoint } = await startServer(token, {
      handler: async (connection, message) => {
        const id =
          typeof message === "object" && message !== null && "id" in message ? message.id : null;
        await connection.send({ jsonrpc: "2.0", id, result: { healthy: true } });
      },
    });
    const socket = await connect(endpoint);
    const handshakeResponse = nextJsonMessage(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));
    await handshakeResponse;

    const applicationResponse = nextJsonMessage(socket);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "bridge/getStatus" }));
    await expect(applicationResponse).resolves.toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { healthy: true },
    });
    socket.terminate();
  });

  it("contains handshake processor failures to the affected connection", async () => {
    const token = generateAuthenticationToken();
    const server = new LoopbackWebSocketServer({
      expectedToken: token,
      createSessionId: () => "invalid-session-id",
      onAuthenticatedMessage: () => undefined,
    });
    servers.push(server);
    const socket = await connect(await server.start());
    const closePromise = nextClose(socket);
    socket.send(JSON.stringify(handshakeRequest(token)));

    await expect(closePromise).resolves.toMatchObject({
      code: 1011,
      reason: "Handshake processing failed",
    });
    expect(server.sessionCount).toBe(0);
  });
});
