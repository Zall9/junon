import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IdeRegisterRequest, SessionId } from "@ide-bridge/protocol";
import {
  IDEBPDaemonServer,
  generateAuthenticationToken,
  writePrivateDiscoveryFile,
} from "@ide-bridge/bridge-daemon";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AuthenticatedBridgeConnection,
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientReconnectingError,
  type BridgeReconnectState,
  type ReconnectingBridgeConnection,
  connectBridgeClientFromDiscoveryFile,
  connectReconnectingBridgeClientFromDiscoveryFile,
} from "../src/index.js";

const servers: IDEBPDaemonServer[] = [];
const directConnections: AuthenticatedBridgeConnection[] = [];
const reconnectingConnections: ReconnectingBridgeConnection[] = [];
const temporaryDirectories: string[] = [];

const topology = {
  hostKind: "local",
  environmentKind: "local",
  uriSchemes: ["file"],
} as const;

afterEach(async () => {
  await Promise.all(
    reconnectingConnections.splice(0).map(async (connection) => await connection.close()),
  );
  await Promise.all(
    directConnections.splice(0).map(async (connection) => await connection.close()),
  );
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

async function discoveryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-reconnect-"));
  temporaryDirectories.push(directory);
  return join(directory, "private", "discovery.json");
}

async function startDaemon(filePath: string, label: string): Promise<IDEBPDaemonServer> {
  const token = generateAuthenticationToken();
  let sessionSequence = 0;
  const server = new IDEBPDaemonServer({
    expectedToken: token,
    createSessionId: () => `session_${label}_${String(++sessionSequence)}` as SessionId,
  });
  servers.push(server);
  const endpoint = await server.start();
  await writePrivateDiscoveryFile({ filePath, endpoint, token });
  return server;
}

function reconnectOptions() {
  return {
    topology,
    reconnectInitialDelayMs: 5,
    reconnectMaxDelayMs: 20,
    reconnectBackoffMultiplier: 2,
    reconnectJitterRatio: 0,
  } as const;
}

function registration(): IdeRegisterRequest["params"] {
  return {
    adapterId: "adapter_reconnect",
    name: "reconnecting-adapter",
    version: "0.1.0",
    ideKind: "vscode",
    ideVersion: "1.125.0",
    positionEncodings: ["utf-16"],
    capabilities: {
      "document/read": { support: "native", guarantee: "semantic" },
    },
    workspaces: [
      {
        workspaceId: "ws_reconnect",
        adapterId: "adapter_reconnect",
        name: "Reconnect workspace",
        roots: [
          {
            rootId: "root_reconnect",
            name: "Reconnect workspace",
            uri: "file:///workspace/reconnect/",
          },
        ],
        workspaceEpoch: 1,
        trust: "trusted",
      },
    ],
  };
}

describe("reconnecting bridge connection", () => {
  it("keeps a quiet shared-client session alive with automatic WebSocket pong frames", async () => {
    const filePath = await discoveryPath();
    const token = generateAuthenticationToken();
    const server = new IDEBPDaemonServer({
      expectedToken: token,
      heartbeatIntervalMs: 60_000,
      maxMissedHeartbeats: 1,
    });
    servers.push(server);
    const endpoint = await server.start();
    await writePrivateDiscoveryFile({ filePath, endpoint, token });
    const connection = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      ...reconnectOptions(),
    });
    reconnectingConnections.push(connection);

    for (let sweep = 0; sweep < 3; sweep += 1) {
      server.sweepSessions();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connection.isConnected).toBe(true);
    expect(server.registry.sessionCount).toBe(1);
  });

  it("rereads rotated discovery metadata after a daemon restart", async () => {
    const filePath = await discoveryPath();
    const firstServer = await startDaemon(filePath, "first");
    const connection = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      ...reconnectOptions(),
    });
    reconnectingConnections.push(connection);
    const states: BridgeReconnectState[] = [];
    connection.onStateChange((state) => states.push(state));

    await expect(connection.request("bridge/getStatus", {})).resolves.toMatchObject({
      sessionCount: 1,
    });
    await firstServer.close();
    await expect.poll(() => connection.state.status).toBe("reconnecting");
    await expect(connection.request("bridge/getStatus", {})).rejects.toBeInstanceOf(
      BridgeClientReconnectingError,
    );

    await startDaemon(filePath, "second");
    await expect.poll(() => connection.session?.sessionId).toBe("session_second_1");
    await expect(connection.request("bridge/getStatus", {})).resolves.toMatchObject({
      sessionCount: 1,
    });
    expect(states.some((state) => state.status === "reconnecting")).toBe(true);
    expect(
      states.some(
        (state) => state.status === "connected" && state.session.sessionId === "session_second_1",
      ),
    ).toBe(true);
  });

  it("rejects an in-flight request on loss without replaying it", async () => {
    const filePath = await discoveryPath();
    const server = await startDaemon(filePath, "inflight");
    const adapter = await connectBridgeClientFromDiscoveryFile(filePath, {
      role: "adapter",
      topology,
    });
    directConnections.push(adapter);
    const handlerStarted = Promise.withResolvers<undefined>();
    adapter.onRequest("document/read", async () => {
      handlerStarted.resolve(undefined);
      return await new Promise<never>(() => undefined);
    });
    await adapter.request("ide/register", registration());

    const consumer = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      ...reconnectOptions(),
    });
    reconnectingConnections.push(consumer);
    const pending = consumer.request("document/read", {
      workspaceId: "ws_reconnect",
      uri: "file:///workspace/reconnect/index.ts",
    });
    await handlerStarted.promise;
    await server.close();

    await expect(pending).rejects.toBeInstanceOf(BridgeClientConnectionError);
    await expect.poll(() => consumer.state.status).toBe("reconnecting");
  });

  it("restores an adapter session and persistent handlers before publishing reconnection", async () => {
    const filePath = await discoveryPath();
    const firstServer = await startDaemon(filePath, "adapter_first");
    const restoreCalls: Array<{ attempt: number; previousSession: string }> = [];
    const adapter = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "adapter",
      ...reconnectOptions(),
      restoreSession: async (connection, context) => {
        expect(context.signal.aborted).toBe(false);
        restoreCalls.push({
          attempt: context.attempt,
          previousSession: context.previousSession.sessionId,
        });
        await connection.request("ide/register", registration(), { signal: context.signal });
      },
    });
    const consumer = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      ...reconnectOptions(),
    });
    reconnectingConnections.push(adapter, consumer);
    adapter.onRequest("document/read", ({ workspaceId, uri }) => ({
      document: {
        workspaceId,
        rootId: "root_reconnect",
        uri,
        revision: {
          editorVersion: 2,
          contentHash: `sha256:${"b".repeat(64)}`,
          workspaceEpoch: 1,
        },
        positionEncoding: "utf-16",
        languageId: "typescript",
        isDirty: false,
      },
      text: "export const reconnected = true;\n",
    }));
    await adapter.request("ide/register", registration());
    const readiness = Promise.withResolvers<string>();
    consumer.onNotification("workspace/readinessChanged", ({ status }) => {
      readiness.resolve(status.state);
    });

    await firstServer.close();
    await expect.poll(() => adapter.state.status).toBe("reconnecting");
    const secondServer = await startDaemon(filePath, "adapter_second");
    await expect.poll(() => adapter.isConnected && consumer.isConnected).toBe(true);
    await expect.poll(() => secondServer.registry.adapterCount).toBe(1);

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toMatchObject({ previousSession: "session_adapter_first_1" });
    await expect(
      consumer.request("document/read", {
        workspaceId: "ws_reconnect",
        uri: "file:///workspace/reconnect/index.ts",
      }),
    ).resolves.toMatchObject({ text: "export const reconnected = true;\n" });
    await adapter.notify("workspace/readinessChanged", {
      status: {
        workspaceId: "ws_reconnect",
        state: "ready",
        capabilitiesUnavailable: [],
        progress: { known: true, percentage: 100 },
      },
    });
    await expect(readiness.promise).resolves.toBe("ready");
  });

  it("caps exponential backoff and stops permanently on explicit close", async () => {
    const filePath = await discoveryPath();
    const server = await startDaemon(filePath, "backoff");
    const connection = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      topology,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10,
      reconnectBackoffMultiplier: 3,
      reconnectJitterRatio: 0,
    });
    reconnectingConnections.push(connection);
    const delays: number[] = [];
    connection.onStateChange((state) => {
      if (state.status === "reconnecting") delays.push(state.nextDelayMs);
    });
    await server.close();
    await expect.poll(() => delays.length).toBeGreaterThanOrEqual(3);
    expect(delays.slice(0, 3)).toEqual([5, 10, 10]);

    await connection.close();
    const attemptsAtClose = delays.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connection.state).toEqual({ status: "closed" });
    expect(delays).toHaveLength(attemptsAtClose);
  });

  it("bounds restoration and does not accumulate callbacks that ignore cancellation", async () => {
    const filePath = await discoveryPath();
    const firstServer = await startDaemon(filePath, "restore_first");
    const gate = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const aborted = Promise.withResolvers<undefined>();
    let restoreCalls = 0;
    const connection = await connectReconnectingBridgeClientFromDiscoveryFile(filePath, {
      role: "consumer",
      ...reconnectOptions(),
      sessionRestoreTimeoutMs: 20,
      restoreSession: async (_candidate, context) => {
        restoreCalls += 1;
        context.signal.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
        started.resolve(undefined);
        await gate.promise;
      },
    });
    reconnectingConnections.push(connection);
    await firstServer.close();
    await expect.poll(() => connection.state.status).toBe("reconnecting");
    const secondServer = await startDaemon(filePath, "restore_second");

    await started.promise;
    await aborted.promise;
    await expect.poll(() => secondServer.registry.sessionCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(restoreCalls).toBe(1);

    await connection.close();
    expect(connection.state).toEqual({ status: "closed" });
    gate.resolve(undefined);
  });

  it("validates reconnect bounds before reading discovery metadata", async () => {
    await expect(
      connectReconnectingBridgeClientFromDiscoveryFile("/does/not/exist", {
        role: "consumer",
        topology,
        reconnectInitialDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectReconnectingBridgeClientFromDiscoveryFile("/does/not/exist", {
        role: "consumer",
        topology,
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 5,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
    await expect(
      connectReconnectingBridgeClientFromDiscoveryFile("/does/not/exist", {
        role: "consumer",
        topology,
        reconnectJitterRatio: 1.1,
      }),
    ).rejects.toBeInstanceOf(BridgeClientConfigurationError);
  });
});
