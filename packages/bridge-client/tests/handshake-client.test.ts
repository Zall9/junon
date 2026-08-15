import type {
  BridgeHandshakeRequest,
  IDEBPDiscoveryFile,
  IDEBPEndpointTopology,
  IDEBPSessionRole,
} from "@ide-bridge/protocol";
import {
  LoopbackWebSocketServer,
  generateAuthenticationToken,
  writePrivateDiscoveryFile,
} from "@ide-bridge/bridge-daemon";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  AuthenticatedBridgeConnection,
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientHandshakeTimeoutError,
  BridgeClientProtocolViolationError,
  BridgeHandshakeRejectedError,
  connectBridgeClient,
  connectBridgeClientFromDiscoveryFile,
} from "../src/index.js";

const daemonServers: LoopbackWebSocketServer[] = [];
const mockServers: WebSocketServer[] = [];
const connections: AuthenticatedBridgeConnection[] = [];
const temporaryDirectories: string[] = [];

const clientTopology: IDEBPEndpointTopology = {
  hostKind: "local",
  environmentKind: "local",
  uriSchemes: ["file"],
};

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (connection) => await connection.close()));
  await Promise.all(daemonServers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    mockServers.splice(0).map(
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
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

function discovery(endpoint: string, token: string): IDEBPDiscoveryFile {
  return {
    protocolVersion: "0.1.0",
    endpoint,
    token,
    pid: 12345,
    startedAt: "2026-08-01T12:00:00Z",
  };
}

async function startDaemon(token: string): Promise<string> {
  const server = new LoopbackWebSocketServer({
    expectedToken: token,
    onAuthenticatedMessage: () => undefined,
  });
  daemonServers.push(server);
  return await server.start();
}

async function startMockDaemon(
  respond: (socket: WebSocket, request: BridgeHandshakeRequest) => void,
): Promise<string> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/rpc",
    perMessageDeflate: false,
  });
  mockServers.push(server);
  server.on("connection", (socket) => {
    socket.once("message", (data) => {
      respond(socket, JSON.parse(data.toString()) as BridgeHandshakeRequest);
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

function successResponse(request: BridgeHandshakeRequest) {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      sessionId: "session_client_test",
      role: request.params.role,
      protocolVersion: "0.1.0",
      daemonInfo: { name: "mock-daemon", version: "0.0.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    },
  };
}

async function connect(
  endpoint: string,
  token: string,
  role: IDEBPSessionRole = "consumer",
  overrides: Partial<Parameters<typeof connectBridgeClient>[0]> = {},
) {
  const connection = await connectBridgeClient({
    discovery: discovery(endpoint, token),
    role,
    topology: clientTopology,
    ...overrides,
  });
  connections.push(connection);
  return connection;
}

describe("authenticated bridge client handshake", () => {
  it.each(["adapter", "consumer"] as const)(
    "establishes and closes a real %s daemon session",
    async (role) => {
      const token = generateAuthenticationToken();
      const endpoint = await startDaemon(token);
      const connection = await connect(endpoint, token, role);

      expect(connection.isOpen).toBe(true);
      expect(connection.session).toMatchObject({ role, protocolVersion: "0.1.0" });
      const server = daemonServers[0];
      await expect.poll(() => server?.sessionCount).toBe(1);

      await connection.close();
      await expect.poll(() => server?.sessionCount).toBe(0);
    },
  );

  it("discovers and authenticates through the private on-disk daemon record", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startDaemon(token);
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-client-e2e-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "private", "discovery.json");
    await writePrivateDiscoveryFile({ filePath, endpoint, token });

    const connection = await connectBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      topology: clientTopology,
    });
    connections.push(connection);

    expect(connection.session).toMatchObject({
      role: "consumer",
      protocolVersion: "0.1.0",
    });
  });

  it("overrides only the endpoint while retaining private-file authentication", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startDaemon(token);
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-client-endpoint-override-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "private", "discovery.json");
    await writePrivateDiscoveryFile({
      filePath,
      endpoint: "ws://127.0.0.1:1/rpc",
      token,
    });

    const connection = await connectBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      topology: clientTopology,
      endpointOverride: endpoint,
    });
    connections.push(connection);

    expect(connection.session.role).toBe("consumer");
  });

  it("rejects a non-loopback endpoint override before sending authentication", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startDaemon(token);
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-client-invalid-override-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "private", "discovery.json");
    await writePrivateDiscoveryFile({ filePath, endpoint, token });

    await expect(
      connectBridgeClientFromDiscoveryFile(filePath, {
        role: "consumer",
        topology: clientTopology,
        endpointOverride: "ws://example.com:41731/rpc",
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
  });

  it("returns a typed generic error for rejected authentication without exposing tokens", async () => {
    const expectedToken = generateAuthenticationToken();
    const suppliedToken = generateAuthenticationToken();
    const endpoint = await startDaemon(expectedToken);

    let rejection: unknown;
    try {
      await connect(endpoint, suppliedToken);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(BridgeHandshakeRejectedError);
    expect(rejection).toMatchObject({
      message: "IDEBP handshake was rejected",
      protocolCode: "AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(String(rejection)).not.toContain(expectedToken);
    expect(String(rejection)).not.toContain(suppliedToken);
  });

  it("maps an unsupported version response to a typed protocol rejection", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startMockDaemon((socket, request) => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32002,
            message: "No compatible protocol version",
            data: {
              code: "UNSUPPORTED_PROTOCOL_VERSION",
              retryable: false,
              supportedProtocol: { minimum: "1.0.0", maximum: "1.0.0" },
            },
          },
        }),
      );
    });

    await expect(connect(endpoint, token)).rejects.toMatchObject({
      name: "BridgeHandshakeRejectedError",
      protocolCode: "UNSUPPORTED_PROTOCOL_VERSION",
      supportedProtocol: { minimum: "1.0.0", maximum: "1.0.0" },
    });
  });

  it("rejects schema-valid responses with mismatched correlation, role, or version", async () => {
    const token = generateAuthenticationToken();
    const mutations = [
      (response: ReturnType<typeof successResponse>) => ({ ...response, id: "other-request" }),
      (response: ReturnType<typeof successResponse>) => ({
        ...response,
        result: { ...response.result, role: "adapter" },
      }),
      (response: ReturnType<typeof successResponse>) => ({
        ...response,
        result: { ...response.result, protocolVersion: "0.2.0" },
      }),
    ];

    for (const mutate of mutations) {
      const endpoint = await startMockDaemon((socket, request) => {
        socket.send(JSON.stringify(mutate(successResponse(request))));
      });
      await expect(connect(endpoint, token)).rejects.toBeInstanceOf(
        BridgeClientProtocolViolationError,
      );
    }
  });

  it("rejects malformed responses without echoing their contents", async () => {
    const token = generateAuthenticationToken();
    const secret = "daemon-secret-that-must-not-be-reported";
    const endpoint = await startMockDaemon((socket, request) => {
      socket.send(JSON.stringify({ ...successResponse(request), secret }));
    });

    let rejection: unknown;
    try {
      await connect(endpoint, token);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(BridgeClientProtocolViolationError);
    expect(String(rejection)).not.toContain(secret);
  });

  it("enforces an overall connection and handshake response timeout", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startMockDaemon(() => undefined);
    await expect(
      connect(endpoint, token, "consumer", { handshakeTimeoutMs: 25 }),
    ).rejects.toBeInstanceOf(BridgeClientHandshakeTimeoutError);
  });

  it("maps a daemon close during handshake to a typed connection error", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startMockDaemon((socket) => {
      socket.close(1011, "mock failure details");
    });
    let rejection: unknown;
    try {
      await connect(endpoint, token);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(BridgeClientConnectionError);
    expect(String(rejection)).not.toContain("mock failure details");
  });

  it("rejects invalid discovery and request configuration before opening a socket", async () => {
    const token = generateAuthenticationToken();
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://0.0.0.0:12345/rpc", token),
        role: "consumer",
        topology: clientTopology,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://127.0.0.1:12345/rpc", token),
        role: "consumer",
        topology: clientTopology,
        createRequestId: () => "",
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://127.0.0.1:12345/rpc", token),
        role: "consumer",
        topology: clientTopology,
        createRequestId: () => {
          throw new Error("factory failure");
        },
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://127.0.0.1:12345/rpc", token),
        role: "adapter",
        topology: clientTopology,
        maxInboundRequests: 0,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://127.0.0.1:12345/rpc", token),
        role: "adapter",
        topology: clientTopology,
        inboundRequestTimeoutMs: 300_001,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      connectBridgeClient({
        discovery: discovery("ws://127.0.0.1:12345/rpc", token),
        role: "consumer",
        topology: clientTopology,
        signal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConnectionError);
  });

  it("snapshots client identity before the asynchronous socket opens", async () => {
    const token = generateAuthenticationToken();
    let receivedName = "";
    const endpoint = await startMockDaemon((socket, request) => {
      receivedName = request.params.clientInfo.name;
      socket.send(JSON.stringify(successResponse(request)));
    });
    const clientInfo = { name: "original-client", version: "1.0.0" };
    const connecting = connect(endpoint, token, "consumer", { clientInfo });
    clientInfo.name = "mutated-after-connect";
    await connecting;

    expect(receivedName).toBe("original-client");
  });

  it("returns cloned session metadata and closes on an unsupported application message", async () => {
    const token = generateAuthenticationToken();
    const endpoint = await startMockDaemon((socket, request) => {
      socket.send(JSON.stringify(successResponse(request)), () => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "workspace/opened", params: {} }));
      });
    });
    const connection = await connect(endpoint, token);
    const snapshot = connection.session;
    snapshot.daemonInfo.name = "mutated-client-side";
    expect(connection.session.daemonInfo.name).toBe("mock-daemon");

    await connection.closed;
    expect(connection.isOpen).toBe(false);
  });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
