import { IDEBPDaemonServer, generateAuthenticationToken } from "@ide-bridge/bridge-daemon";
import { afterEach, describe, expect, it } from "vitest";

import { type AuthenticatedBridgeConnection, connectBridgeClient } from "../src/index.js";

const servers: IDEBPDaemonServer[] = [];
const connections: AuthenticatedBridgeConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (connection) => await connection.close()));
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe("typed client with routed daemon", () => {
  it("registers an adapter and consumes registry state and notifications", async () => {
    const token = generateAuthenticationToken();
    const server = new IDEBPDaemonServer({ expectedToken: token });
    servers.push(server);
    const endpoint = await server.start();
    const discovery = {
      protocolVersion: "0.1.0",
      endpoint,
      token,
      pid: 12_345,
      startedAt: "2026-08-01T12:00:00Z",
    } as const;
    const topology = {
      hostKind: "local",
      environmentKind: "local",
      uriSchemes: ["file"],
    } as const;
    const adapter = await connectBridgeClient({ discovery, role: "adapter", topology });
    const consumer = await connectBridgeClient({ discovery, role: "consumer", topology });
    connections.push(adapter, consumer);

    adapter.onRequest("document/read", ({ workspaceId, uri }) => ({
      document: {
        workspaceId,
        rootId: "root_typed",
        uri,
        revision: {
          editorVersion: 7,
          contentHash: `sha256:${"a".repeat(64)}`,
          workspaceEpoch: 1,
        },
        positionEncoding: "utf-16",
        languageId: "typescript",
        isDirty: true,
      },
      text: "export const typed = true;\n",
    }));

    await expect(
      adapter.request("ide/register", {
        adapterId: "adapter_typed",
        name: "typed-adapter",
        version: "0.1.0",
        ideKind: "vscode",
        ideVersion: "1.125.0",
        positionEncodings: ["utf-16"],
        capabilities: {
          "document/read": { support: "native", guarantee: "semantic" },
        },
        workspaces: [
          {
            workspaceId: "ws_typed",
            adapterId: "adapter_typed",
            name: "typed workspace",
            roots: [
              {
                rootId: "root_typed",
                name: "typed workspace",
                uri: "file:///workspace/typed/",
              },
            ],
            workspaceEpoch: 1,
            trust: "trusted",
          },
        ],
      }),
    ).resolves.toMatchObject({ adapter: { adapterId: "adapter_typed" } });
    await expect(consumer.request("workspace/list", {})).resolves.toMatchObject({
      workspaces: [{ workspaceId: "ws_typed", adapterId: "adapter_typed" }],
    });

    const readiness = Promise.withResolvers<"ready">();
    consumer.onNotification("workspace/readinessChanged", ({ status }) => {
      if (status.state === "ready") readiness.resolve("ready");
    });
    await adapter.notify("workspace/readinessChanged", {
      status: {
        workspaceId: "ws_typed",
        state: "ready",
        capabilitiesUnavailable: [],
        progress: { known: true, percentage: 100 },
      },
    });
    await expect(readiness.promise).resolves.toBe("ready");
    await expect(
      consumer.request("workspace/getStatus", { workspaceId: "ws_typed" }),
    ).resolves.toMatchObject({ status: { state: "ready", progress: { percentage: 100 } } });
    await expect(consumer.request("bridge/getStatus", {})).resolves.toMatchObject({
      adapterCount: 1,
      workspaceCount: 1,
      sessionCount: 2,
    });
    await expect(
      consumer.request("document/read", {
        workspaceId: "ws_typed",
        uri: "file:///workspace/typed/src/index.ts",
      }),
    ).resolves.toMatchObject({
      document: {
        workspaceId: "ws_typed",
        uri: "file:///workspace/typed/src/index.ts",
        revision: { editorVersion: 7, workspaceEpoch: 1 },
      },
      text: "export const typed = true;\n",
    });
  });
});
