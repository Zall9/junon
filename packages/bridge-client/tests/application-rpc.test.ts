import type {
  BridgeHandshakeRequest,
  IDEBPDiscoveryFile,
  IDEBPSessionRole,
} from "@ide-bridge/protocol";
import { generateAuthenticationToken } from "@ide-bridge/bridge-daemon";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  AuthenticatedBridgeConnection,
  BridgeClientConfigurationError,
  BridgeClientProtocolViolationError,
  BridgeClientRequestCancelledError,
  BridgeClientRequestTimeoutError,
  BridgeClientRpcError,
  connectBridgeClient,
} from "../src/index.js";

type ApplicationHandler = (socket: WebSocket, message: Record<string, unknown>) => void;

const servers: WebSocketServer[] = [];
const connections: AuthenticatedBridgeConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (connection) => await connection.close()));
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          for (const client of server.clients) client.terminate();
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
});

function handshakeResponse(request: BridgeHandshakeRequest) {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      sessionId: "session_rpc_test",
      role: request.params.role,
      protocolVersion: "0.1.0",
      daemonInfo: { name: "mock-daemon", version: "0.0.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    },
  };
}

async function startMockDaemon(onApplicationMessage: ApplicationHandler): Promise<string> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/rpc",
    perMessageDeflate: false,
  });
  servers.push(server);
  server.on("connection", (socket) => {
    let authenticated = false;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!authenticated) {
        authenticated = true;
        socket.send(
          JSON.stringify(handshakeResponse(message as unknown as BridgeHandshakeRequest)),
        );
        return;
      }
      onApplicationMessage(socket, message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Mock daemon did not start");
  return `ws://127.0.0.1:${String(address.port)}/rpc`;
}

async function connect(
  onApplicationMessage: ApplicationHandler,
  role: IDEBPSessionRole = "consumer",
) {
  const token = generateAuthenticationToken();
  const endpoint = await startMockDaemon(onApplicationMessage);
  const discovery: IDEBPDiscoveryFile = {
    protocolVersion: "0.1.0",
    endpoint,
    token,
    pid: 12_345,
    startedAt: "2026-08-01T12:00:00Z",
  };
  const connection = await connectBridgeClient({
    discovery,
    role,
    topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
  });
  connections.push(connection);
  return connection;
}

function statusResult() {
  return {
    daemonVersion: "0.0.0",
    protocol: { minimum: "0.1.0", maximum: "0.1.0" },
    startedAt: "2026-08-01T12:00:00Z",
    uptimeMs: 1_000,
    adapterCount: 0,
    workspaceCount: 0,
    sessionCount: 1,
  };
}

describe("authenticated application JSON-RPC", () => {
  it("correlates and validates a typed method-specific response", async () => {
    const connection = await connect((socket, request) => {
      expect(request).toMatchObject({ method: "bridge/getStatus" });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request["id"],
          result: statusResult(),
        }),
      );
    });

    await expect(connection.request("bridge/getStatus", {})).resolves.toEqual(statusResult());
  });

  it("maps normalized daemon errors without exposing the daemon message", async () => {
    const secret = "sensitive-daemon-diagnostic";
    const connection = await connect((socket, request) => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request["id"],
          error: {
            code: -32000,
            message: secret,
            data: {
              code: "WORKSPACE_NOT_FOUND",
              retryable: false,
              details: { workspaceId: "ws_missing" },
            },
          },
        }),
      );
    });

    let rejection: unknown;
    try {
      await connection.request("workspace/get", { workspaceId: "ws_missing" });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(BridgeClientRpcError);
    expect(rejection).toMatchObject({
      message: "IDEBP request failed",
      protocolCode: "WORKSPACE_NOT_FOUND",
      retryable: false,
      details: { workspaceId: "ws_missing" },
    });
    expect(String(rejection)).not.toContain(secret);
  });

  it("sends and receives schema-validated notifications", async () => {
    const received = Promise.withResolvers<{ adapterId: string; reason: string }>();
    const connection = await connect((socket, message) => {
      expect(message).toEqual({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id: "request_external" },
      });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "adapter/disconnected",
          params: { adapterId: "adapter_fixture", reason: "transport-lost" },
        }),
      );
    });
    connection.onNotification("adapter/disconnected", (params) => {
      received.resolve(params);
    });

    await connection.notify("$/cancelRequest", { id: "request_external" });
    await expect(received.promise).resolves.toEqual({
      adapterId: "adapter_fixture",
      reason: "transport-lost",
    });
  });

  it("times out, sends cancellation, and tolerates one valid late response", async () => {
    let requestId: unknown;
    const cancellationObserved = Promise.withResolvers<undefined>();
    const connection = await connect((socket, message) => {
      if (message["method"] === "bridge/getStatus" && requestId === undefined) {
        requestId = message["id"];
        return;
      }
      if (message["method"] === "$/cancelRequest") {
        expect(message["params"]).toEqual({ id: requestId });
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: statusResult(),
          }),
        );
        cancellationObserved.resolve(undefined);
        return;
      }
      if (message["method"] === "bridge/getStatus") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: statusResult() }));
      }
    });

    await expect(
      connection.request("bridge/getStatus", {}, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(BridgeClientRequestTimeoutError);
    await cancellationObserved.promise;
    await expect(connection.request("bridge/getStatus", {})).resolves.toEqual(statusResult());
  });

  it("uses AbortSignal cancellation exactly once", async () => {
    let requestId: unknown;
    let cancellationCount = 0;
    const cancellationObserved = Promise.withResolvers<undefined>();
    const connection = await connect((_socket, message) => {
      if (message["method"] === "workspace/list") {
        requestId = message["id"];
      } else if (message["method"] === "$/cancelRequest") {
        expect(message["params"]).toEqual({ id: requestId });
        cancellationCount += 1;
        cancellationObserved.resolve(undefined);
      }
    });
    const controller = new AbortController();
    const request = connection.request("workspace/list", {}, { signal: controller.signal });
    controller.abort();
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(BridgeClientRequestCancelledError);
    await cancellationObserved.promise;
    expect(cancellationCount).toBe(1);
  });

  it("rejects invalid outgoing parameters before sending", async () => {
    let applicationMessages = 0;
    const connection = await connect(() => {
      applicationMessages += 1;
    });

    await expect(
      connection.request("workspace/get", { workspaceId: "bad id with spaces" }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    expect(applicationMessages).toBe(0);
  });

  it("rejects requests and notifications outside the authenticated role", async () => {
    let applicationMessages = 0;
    const consumer = await connect(() => {
      applicationMessages += 1;
    });
    const adapter = await connect(() => {
      applicationMessages += 1;
    }, "adapter");

    await expect(
      consumer.request("ide/ping", { sentAt: "2026-08-01T12:00:00Z" }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(adapter.request("workspace/list", {})).rejects.toBeInstanceOf(
      BridgeClientConfigurationError,
    );
    await expect(
      consumer.notify("adapter/disconnected", {
        adapterId: "adapter_fixture",
        reason: "transport-lost",
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      adapter.notify("$/cancelRequest", { id: "request_external" }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    expect(applicationMessages).toBe(0);
  });

  it("closes on a success response that does not match the pending method schema", async () => {
    const connection = await connect((socket, request) => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request["id"],
          result: { workspaces: [] },
        }),
      );
    });

    await expect(connection.request("bridge/getStatus", {})).rejects.toBeInstanceOf(
      BridgeClientProtocolViolationError,
    );
    await connection.closed;
    expect(connection.isOpen).toBe(false);
  });

  it("closes on unknown response identifiers", async () => {
    const connection = await connect((socket) => {
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: "request_unknown", result: statusResult() }),
      );
    });

    await expect(connection.request("bridge/getStatus", {})).rejects.toBeInstanceOf(
      BridgeClientProtocolViolationError,
    );
  });
});
