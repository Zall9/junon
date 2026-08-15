import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  connectBridgeClientFromDiscoveryFile,
  type AuthenticatedBridgeConnection,
} from "@ide-bridge/bridge-client";
import {
  IDEBPDaemonServer,
  generateAuthenticationToken,
  writePrivateDiscoveryFile,
} from "@ide-bridge/bridge-daemon";
import type {
  AdapterId,
  IDEBPEndpointTopology,
  IdeRegisterRequest,
  RootId,
  WorkspaceId,
} from "@ide-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdapterLifecycle } from "../src/adapter-lifecycle.js";
import type { OwnedDaemonProcess } from "../src/daemon-process.js";
import type { VscodeDocumentUriLike } from "../src/document-mapper.js";
import { hashInMemoryContent } from "../src/document-mapper.js";
import { VscodeDocumentRoutes } from "../src/document-routes.js";
import type { SafeLifecycleLogger } from "../src/safe-logger.js";
import { VscodeSymbolRoutes } from "../src/symbol-routes.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const topology: IDEBPEndpointTopology = {
  hostKind: "local",
  environmentKind: "local",
  uriSchemes: ["file"],
};
const directories: string[] = [];
const servers: IDEBPDaemonServer[] = [];
const consumers: AuthenticatedBridgeConnection[] = [];
const lifecycles: AdapterLifecycle[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(async (lifecycle) => await lifecycle.stop()));
  await Promise.all(consumers.splice(0).map(async (connection) => await connection.close()));
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

async function discoveryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-vscode-lifecycle-"));
  directories.push(directory);
  const filePath = join(directory, "private", "discovery.json");
  await mkdir(dirname(filePath), { recursive: true });
  return filePath;
}

async function startDaemon(filePath: string): Promise<IDEBPDaemonServer> {
  const token = generateAuthenticationToken();
  const server = new IDEBPDaemonServer({ expectedToken: token });
  servers.push(server);
  const endpoint = await server.start();
  await writePrivateDiscoveryFile({ filePath, endpoint, token });
  return server;
}

function registration(
  epoch: () => number,
  includeDocumentSymbols = false,
): IdeRegisterRequest["params"] {
  return {
    adapterId: "adapter_vscode_lifecycle",
    name: "IDE Bridge for VS Code",
    version: "0.0.0",
    ideKind: "vscode",
    ideVersion: "1.125.0",
    positionEncodings: ["utf-16"],
    capabilities: {
      "document/read": { support: "native" },
      "document/getRevision": { support: "native" },
      ...(includeDocumentSymbols
        ? { "document/getSymbols": { support: "provider", guarantee: "semantic" } as const }
        : {}),
    },
    workspaces: [
      {
        workspaceId: "ws_vscode_lifecycle",
        adapterId: "adapter_vscode_lifecycle",
        name: "Lifecycle fixture",
        roots: [
          {
            rootId: "root_vscode_lifecycle",
            name: "Lifecycle fixture",
            uri: "file:///workspace/lifecycle",
          },
        ],
        workspaceEpoch: epoch(),
        trust: "trusted",
      },
    ],
  };
}

function logger(): SafeLifecycleLogger {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

async function consumer(filePath: string): Promise<AuthenticatedBridgeConnection> {
  const connection = await connectBridgeClientFromDiscoveryFile(filePath, {
    role: "consumer",
    topology,
  });
  consumers.push(connection);
  return connection;
}

describe("VS Code authenticated adapter lifecycle", () => {
  it("registers current workspace state and unregisters cleanly", async () => {
    const filePath = await discoveryPath();
    await startDaemon(filePath);
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: false,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/unused/daemon-child.js",
      registration: () => registration(() => 0),
      logger: logger(),
    });
    lifecycles.push(lifecycle);

    await lifecycle.start();
    const observer = await consumer(filePath);
    await expect(observer.request("bridge/listAdapters", {})).resolves.toMatchObject({
      adapters: [
        {
          adapterId: "adapter_vscode_lifecycle",
          capabilities: {
            "document/read": { support: "native" },
            "document/getRevision": { support: "native" },
          },
        },
      ],
    });
    await expect(observer.request("workspace/list", {})).resolves.toMatchObject({
      workspaces: [{ workspaceId: "ws_vscode_lifecycle", workspaceEpoch: 0 }],
    });

    await lifecycle.stop();
    await expect(observer.request("bridge/listAdapters", {})).resolves.toEqual({ adapters: [] });
  });

  it("serves unsaved document reads and revisions through the real daemon", async () => {
    const filePath = await discoveryPath();
    await startDaemon(filePath);
    const rootUri = testUri("file:///workspace/lifecycle");
    const documentUri = testUri("file:///workspace/lifecycle/src/value.ts");
    const folder = { name: "Lifecycle fixture", uri: rootUri };
    const workspaceModel = new VscodeWorkspaceModel(
      "adapter_vscode_lifecycle" as AdapterId,
      "ws_vscode_lifecycle" as WorkspaceId,
      () => "root_vscode_lifecycle" as RootId,
    );
    let text = "export const value = 1;\n";
    let version = 3;
    const currentWorkspaces = () => workspaceModel.snapshot([folder], { trusted: true });
    const routes = new VscodeDocumentRoutes({
      host: {
        parseUri: (value) => testUri(value),
        getWorkspaceFolder: (uri) =>
          uri.toString().startsWith(`${rootUri.toString()}/`) ? folder : undefined,
        openTextDocument: async () => ({
          uri: documentUri,
          get version() {
            return version;
          },
          languageId: "typescript",
          isDirty: true,
          getText: () => text,
        }),
      },
      workspaceModel,
      currentWorkspace: () => currentWorkspaces()[0],
    });
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: false,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/unused/daemon-child.js",
      registration: () => registration(() => workspaceModel.workspaceEpoch),
      configureConnection: (connection) => routes.attach(connection),
      logger: logger(),
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();
    const observer = await consumer(filePath);

    await expect(
      observer.request("document/read", {
        workspaceId: "ws_vscode_lifecycle",
        uri: documentUri.toString(),
      }),
    ).resolves.toMatchObject({
      text,
      document: {
        revision: { editorVersion: 3, contentHash: hashInMemoryContent(text) },
        isDirty: true,
      },
    });

    text = "export const value = 2;\n";
    version = 4;
    await expect(
      observer.request("document/getRevision", {
        workspaceId: "ws_vscode_lifecycle",
        uri: documentUri.toString(),
      }),
    ).resolves.toEqual({
      document: expect.objectContaining({
        revision: expect.objectContaining({
          editorVersion: 4,
          contentHash: hashInMemoryContent(text),
        }),
      }),
    });
  });

  it("serves document symbols with handles bound to the authenticated adapter session", async () => {
    const filePath = await discoveryPath();
    await startDaemon(filePath);
    const rootUri = testUri("file:///workspace/lifecycle");
    const documentUri = testUri("file:///workspace/lifecycle/src/service.ts");
    const folder = { name: "Lifecycle fixture", uri: rootUri };
    const workspaceModel = new VscodeWorkspaceModel(
      "adapter_vscode_lifecycle" as AdapterId,
      "ws_vscode_lifecycle" as WorkspaceId,
      () => "root_vscode_lifecycle" as RootId,
    );
    const currentWorkspaces = () => workspaceModel.snapshot([folder], { trusted: true });
    const documentRoutes = new VscodeDocumentRoutes({
      host: {
        parseUri: (value) => testUri(value),
        getWorkspaceFolder: (uri) =>
          uri.toString().startsWith(`${rootUri.toString()}/`) ? folder : undefined,
        openTextDocument: async () => ({
          uri: documentUri,
          version: 5,
          languageId: "typescript",
          isDirty: true,
          getText: () => "export class Service { run(): void {} }\n",
        }),
      },
      workspaceModel,
      currentWorkspace: () => currentWorkspaces()[0],
    });
    const symbolRoutes = new VscodeSymbolRoutes({
      adapterId: "adapter_vscode_lifecycle" as AdapterId,
      documentRoutes,
      provider: {
        provideDocumentSymbols: async () => [
          {
            name: "Service",
            kind: 4,
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 39 },
            },
            selectionRange: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 20 },
            },
            children: [],
          },
        ],
        provideWorkspaceSymbols: async () => [],
      },
      currentWorkspace: () => currentWorkspaces()[0],
    });
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: false,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/unused/daemon-child.js",
      registration: () => registration(() => workspaceModel.workspaceEpoch, true),
      configureConnection: (connection) => {
        const disposeDocuments = documentRoutes.attach(connection);
        const disposeSymbols = symbolRoutes.attach(connection);
        return () => {
          disposeSymbols();
          disposeDocuments();
        };
      },
      logger: logger(),
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();
    const observer = await consumer(filePath);
    const adapters = await observer.request("bridge/listAdapters", {});
    const adapterSessionId = adapters.adapters[0]?.sessionId;

    await expect(
      observer.request("document/getSymbols", {
        workspaceId: "ws_vscode_lifecycle",
        uri: documentUri.toString(),
      }),
    ).resolves.toMatchObject({
      document: { uri: documentUri.toString(), revision: { editorVersion: 5 } },
      symbols: [
        {
          handle: {
            adapterId: "adapter_vscode_lifecycle",
            sessionId: adapterSessionId,
            validUntilEpoch: 0,
          },
          locator: { name: "Service", kind: "class", documentUri: documentUri.toString() },
        },
      ],
    });
  });

  it("re-registers current state with a new epoch after daemon rotation", async () => {
    const filePath = await discoveryPath();
    const first = await startDaemon(filePath);
    let epoch = 0;
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: false,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/unused/daemon-child.js",
      registration: (reason) => {
        if (reason === "reconnect") epoch += 1;
        return registration(() => epoch);
      },
      logger: logger(),
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();

    await first.close();
    await startDaemon(filePath);
    await waitUntil(() => lifecycle.isConnected && epoch > 0);
    const observer = await consumer(filePath);
    await expect(observer.request("workspace/list", {})).resolves.toMatchObject({
      workspaces: [{ workspaceId: "ws_vscode_lifecycle", workspaceEpoch: 1 }],
    });
    expect(epoch).toBe(1);
  });

  it("auto-starts only with absent or already valid private discovery state", async () => {
    const filePath = await discoveryPath();
    let ownedServer: IDEBPDaemonServer | undefined;
    const owned: OwnedDaemonProcess = {
      exited: new Promise(() => undefined),
      stop: async () => {
        await ownedServer?.close();
      },
    };
    const spawnDaemon = vi.fn(() => {
      void startDaemon(filePath).then((server) => {
        ownedServer = server;
      });
      return owned;
    });
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: true,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/extension/dist/daemon-child.js",
      registration: () => registration(() => 0),
      logger: logger(),
      spawnDaemon,
      initialConnectTimeoutMs: 100,
      startupTimeoutMs: 3_000,
    });
    lifecycles.push(lifecycle);

    await lifecycle.start();
    expect(spawnDaemon).toHaveBeenCalledOnce();
    expect(lifecycle.isConnected).toBe(true);
  });

  it("refuses to overwrite an existing invalid discovery file", async () => {
    const filePath = await discoveryPath();
    await writeFile(filePath, "invalid", { mode: 0o600 });
    await chmod(filePath, 0o600);
    const spawnDaemon = vi.fn();
    const lifecycle = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: true,
        discoveryFile: filePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/extension/dist/daemon-child.js",
      registration: () => registration(() => 0),
      logger: logger(),
      spawnDaemon,
      initialConnectTimeoutMs: 100,
    });
    lifecycles.push(lifecycle);

    await expect(lifecycle.start()).rejects.toThrow("discovery state is invalid");
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("does not auto-start for manual endpoints or remote extension hosts", async () => {
    const manualPath = await discoveryPath();
    const manualSpawn = vi.fn();
    const manual = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: true,
        discoveryFile: manualPath,
        endpointOverride: "ws://127.0.0.1:43127/rpc",
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology,
      daemonScriptPath: "/extension/dist/daemon-child.js",
      registration: () => registration(() => 0),
      logger: logger(),
      spawnDaemon: manualSpawn,
      initialConnectTimeoutMs: 100,
    });
    lifecycles.push(manual);
    await expect(manual.start()).rejects.toThrow("disabled with a manual endpoint");
    expect(manualSpawn).not.toHaveBeenCalled();

    const remotePath = await discoveryPath();
    const remoteSpawn = vi.fn();
    const remote = new AdapterLifecycle({
      configuration: {
        autoStartDaemon: true,
        discoveryFile: remotePath,
        logLevel: "info",
        providerTimeoutMs: 1_000,
      },
      topology: {
        hostKind: "remote-workspace",
        environmentKind: "ssh",
        uriSchemes: ["vscode-remote"],
      },
      daemonScriptPath: "/extension/dist/daemon-child.js",
      registration: () => registration(() => 0),
      logger: logger(),
      spawnDaemon: remoteSpawn,
      initialConnectTimeoutMs: 100,
    });
    lifecycles.push(remote);
    await expect(remote.start()).rejects.toThrow("remote extension hosts");
    expect(remoteSpawn).not.toHaveBeenCalled();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle state");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function testUri(value: string): VscodeDocumentUriLike {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: decodeURIComponent(parsed.pathname),
    toString: () => value,
  };
}
