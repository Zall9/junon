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
  BridgeAdapterRequestError,
  BridgeClientConfigurationError,
  connectBridgeClient,
} from "../src/index.js";

const servers: WebSocketServer[] = [];
const connections: AuthenticatedBridgeConnection[] = [];

class DaemonPeer {
  readonly socket: WebSocket;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(message: unknown) => void> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  get queuedMessageCount(): number {
    return this.#messages.length;
  }

  receive(message: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#messages.push(message);
    else waiter(message);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async next(): Promise<unknown> {
    const message = this.#messages.shift();
    if (message !== undefined) return message;
    return await new Promise<unknown>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

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
      sessionId: `session_${request.params.role}_dispatch`,
      role: request.params.role,
      protocolVersion: "0.1.0",
      daemonInfo: { name: "mock-daemon", version: "0.0.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    },
  };
}

async function connectPeer(
  role: IDEBPSessionRole = "adapter",
  options: { inboundRequestTimeoutMs?: number; maxInboundRequests?: number } = {},
): Promise<{ connection: AuthenticatedBridgeConnection; daemon: DaemonPeer }> {
  const peer = Promise.withResolvers<DaemonPeer>();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/rpc",
    perMessageDeflate: false,
  });
  servers.push(server);
  server.on("connection", (socket) => {
    let daemon: DaemonPeer | undefined;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as unknown;
      if (daemon === undefined) {
        const request = message as BridgeHandshakeRequest;
        socket.send(JSON.stringify(handshakeResponse(request)));
        daemon = new DaemonPeer(socket);
        peer.resolve(daemon);
      } else {
        daemon.receive(message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Mock daemon did not start");
  const token = generateAuthenticationToken();
  const discovery: IDEBPDiscoveryFile = {
    protocolVersion: "0.1.0",
    endpoint: `ws://127.0.0.1:${String(address.port)}/rpc`,
    token,
    pid: 12_345,
    startedAt: "2026-08-01T12:00:00Z",
  };
  const connection = await connectBridgeClient({
    discovery,
    role,
    topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    ...options,
  });
  connections.push(connection);
  return { connection, daemon: await peer.promise };
}

function readRequest(id: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "document/read",
    params: { workspaceId: "ws_dispatch", uri: "file:///workspace/dispatch/a.ts" },
  } as const;
}

function readResult() {
  return {
    document: {
      workspaceId: "ws_dispatch",
      rootId: "root_dispatch",
      uri: "file:///workspace/dispatch/a.ts",
      revision: {
        editorVersion: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        workspaceEpoch: 1,
      },
      positionEncoding: "utf-16",
      languageId: "typescript",
      isDirty: false,
    },
    text: "export const a = 1;\n",
  } as const;
}

function cancellation(id: string) {
  return { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } } as const;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("adapter inbound request dispatch", () => {
  it("dispatches schema-validated params and returns a method-validated result", async () => {
    const { connection, daemon } = await connectPeer();
    connection.onRequest("document/read", (params, context) => {
      expect(params).toEqual(readRequest("ignored").params);
      expect(context).toMatchObject({
        id: "route_read",
        method: "document/read",
        sessionId: expect.stringMatching(/^session_/u),
      });
      expect(context.signal.aborted).toBe(false);
      return readResult();
    });

    daemon.send(readRequest("route_read"));
    await expect(daemon.next()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "route_read",
      result: readResult(),
    });
  });

  it("normalizes declared errors and invalid handler results without leaking exceptions", async () => {
    const { connection, daemon } = await connectPeer();
    const dispose = connection.onRequest("document/read", () => {
      throw new BridgeAdapterRequestError({
        code: "DOCUMENT_NOT_FOUND",
        retryable: false,
        details: {
          workspaceId: "ws_dispatch",
          documentUri: "file:///workspace/dispatch/a.ts",
        },
      });
    });
    daemon.send(readRequest("route_declared_error"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_declared_error",
      error: {
        message: "IDEBP adapter request failed",
        data: { code: "DOCUMENT_NOT_FOUND", retryable: false },
      },
    });

    dispose();
    const disposeInvalid = connection.onRequest(
      "document/read",
      () => ({ secret: "must-not-cross-wire" }) as never,
    );
    daemon.send(readRequest("route_invalid_result"));
    const invalidResult = await daemon.next();
    expect(invalidResult).toMatchObject({
      id: "route_invalid_result",
      error: { data: { code: "PROVIDER_FAILED", retryable: false } },
    });
    expect(JSON.stringify(invalidResult)).not.toContain("must-not-cross-wire");

    disposeInvalid();
    connection.onRequest("document/read", () => {
      throw new Error("sensitive-provider-exception");
    });
    daemon.send(readRequest("route_unexpected_error"));
    const unexpectedError = await daemon.next();
    expect(unexpectedError).toMatchObject({
      id: "route_unexpected_error",
      error: { data: { code: "PROVIDER_FAILED", retryable: false } },
    });
    expect(JSON.stringify(unexpectedError)).not.toContain("sensitive-provider-exception");
  });

  it("rejects duplicate registration and returns capability unavailable after disposal", async () => {
    const { connection, daemon } = await connectPeer();
    const dispose = connection.onRequest("document/read", () => readResult());
    expect(() => connection.onRequest("document/read", () => readResult())).toThrow(
      BridgeClientConfigurationError,
    );
    dispose();

    daemon.send(readRequest("route_missing_handler"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_missing_handler",
      error: {
        data: {
          code: "CAPABILITY_UNAVAILABLE",
          details: { capability: "document/read" },
        },
      },
    });
  });

  it("aborts once on daemon cancellation and ignores late handler completion", async () => {
    const { connection, daemon } = await connectPeer();
    const gate = Promise.withResolvers<ReturnType<typeof readResult>>();
    const aborted = Promise.withResolvers<undefined>();
    let abortCount = 0;
    connection.onRequest("document/read", async (_params, context) => {
      context.signal.addEventListener(
        "abort",
        () => {
          abortCount += 1;
          aborted.resolve(undefined);
        },
        { once: true },
      );
      return await gate.promise;
    });

    daemon.send(readRequest("route_cancel"));
    await delay(10);
    daemon.send(cancellation("route_cancel"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_cancel",
      error: { data: { code: "CANCELLED" } },
    });
    await aborted.promise;
    gate.resolve(readResult());
    await delay(10);
    expect(abortCount).toBe(1);
    expect(daemon.queuedMessageCount).toBe(0);

    daemon.send(readRequest("route_cancel"));
    await connection.closed;
    expect(connection.isOpen).toBe(false);
  });

  it("bounds concurrent work and times handlers out", async () => {
    const { connection, daemon } = await connectPeer("adapter", {
      inboundRequestTimeoutMs: 30,
      maxInboundRequests: 1,
    });
    const started = Promise.withResolvers<undefined>();
    connection.onRequest("document/read", async () => {
      started.resolve(undefined);
      return await new Promise<ReturnType<typeof readResult>>(() => undefined);
    });
    daemon.send(readRequest("route_slow"));
    await started.promise;
    daemon.send(readRequest("route_over_capacity"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_over_capacity",
      error: { data: { code: "PRECONDITION_FAILED" } },
    });
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_slow",
      error: { data: { code: "TIMEOUT", retryable: true } },
    });
    daemon.send(readRequest("route_after_timeout"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_after_timeout",
      error: { data: { code: "PRECONDITION_FAILED" } },
    });
  });

  it("absorbs one cancellation crossing a completed response", async () => {
    const { connection, daemon } = await connectPeer();
    connection.onRequest("document/read", () => readResult());
    daemon.send(readRequest("route_complete"));
    await daemon.next();
    daemon.send(cancellation("route_complete"));
    await delay(10);
    expect(connection.isOpen).toBe(true);

    daemon.send(readRequest("route_after_late_cancel"));
    await expect(daemon.next()).resolves.toMatchObject({
      id: "route_after_late_cancel",
      result: { text: "export const a = 1;\n" },
    });
  });

  it("fails closed on duplicate IDs, unknown cancellations, and wrong-direction requests", async () => {
    const duplicate = await connectPeer();
    duplicate.connection.onRequest(
      "document/read",
      async () => await new Promise<ReturnType<typeof readResult>>(() => undefined),
    );
    duplicate.daemon.send(readRequest("route_duplicate"));
    duplicate.daemon.send(readRequest("route_duplicate"));
    await duplicate.connection.closed;
    expect(duplicate.connection.isOpen).toBe(false);

    const unknownCancellation = await connectPeer();
    unknownCancellation.daemon.send(cancellation("route_unknown"));
    await unknownCancellation.connection.closed;
    expect(unknownCancellation.connection.isOpen).toBe(false);

    const wrongAdapterNotification = await connectPeer();
    wrongAdapterNotification.daemon.send({
      jsonrpc: "2.0",
      method: "adapter/disconnected",
      params: { adapterId: "adapter_dispatch", reason: "transport-lost" },
    });
    await wrongAdapterNotification.connection.closed;
    expect(wrongAdapterNotification.connection.isOpen).toBe(false);

    const consumer = await connectPeer("consumer");
    expect(() => consumer.connection.onRequest("document/read", () => readResult())).toThrow(
      BridgeClientConfigurationError,
    );
    consumer.daemon.send(readRequest("route_wrong_direction"));
    await consumer.connection.closed;
    expect(consumer.connection.isOpen).toBe(false);

    const consumerCancellation = await connectPeer("consumer");
    consumerCancellation.daemon.send(cancellation("route_wrong_consumer_direction"));
    await consumerCancellation.connection.closed;
    expect(consumerCancellation.connection.isOpen).toBe(false);
  });

  it("aborts active handler signals when the connection closes", async () => {
    const { connection, daemon } = await connectPeer();
    const aborted = Promise.withResolvers<undefined>();
    connection.onRequest("document/read", async (_params, context) => {
      context.signal.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
      return await new Promise<ReturnType<typeof readResult>>(() => undefined);
    });
    daemon.send(readRequest("route_close"));
    await delay(10);
    daemon.socket.terminate();
    await connection.closed;
    await aborted.promise;
  });
});
