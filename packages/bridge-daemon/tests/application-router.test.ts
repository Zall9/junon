import {
  IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT,
  IDEBP_MAX_SYMBOL_LOCATIONS,
} from "@ide-bridge/protocol";
import type { IDEBPSessionRole } from "@ide-bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { IDEBPDaemonServer } from "../src/daemon-server.js";
import { StructuredLogger } from "../src/observability/structured-logger.js";
import { generateAuthenticationToken } from "../src/security/authentication-token.js";

const servers: IDEBPDaemonServer[] = [];
const peers: JsonPeer[] = [];

class JsonPeer {
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  sessionId: string | undefined;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(message: unknown) => void> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as unknown;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(message);
      else waiter(message);
    });
  }

  get queuedMessageCount(): number {
    return this.#messages.length;
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

  terminate(): void {
    this.socket.terminate();
  }
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.terminate();
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

function handshakeRequest(token: string, role: IDEBPSessionRole, id: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "bridge/handshake",
    params: {
      authentication: { method: "token", token },
      role,
      protocol: { minimum: "0.1.0", maximum: "0.1.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
      clientInfo: { name: `${role}-router-test`, version: "0.1.0" },
    },
  };
}

async function startDaemon(
  options: {
    routeTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    maxMissedHeartbeats?: number;
    now?: () => Date;
    logger?: StructuredLogger;
  } = {},
): Promise<{ server: IDEBPDaemonServer; token: string; endpoint: string }> {
  const token = generateAuthenticationToken();
  const server = new IDEBPDaemonServer({ expectedToken: token, ...options });
  servers.push(server);
  return { server, token, endpoint: await server.start() };
}

async function connectPeer(
  endpoint: string,
  token: string,
  role: IDEBPSessionRole,
  suffix: string,
  autoPong = true,
): Promise<JsonPeer> {
  const socket = new WebSocket(endpoint, { autoPong });
  await new Promise<undefined>((resolve, reject) => {
    socket.once("open", () => resolve(undefined));
    socket.once("error", reject);
  });
  const peer = new JsonPeer(socket);
  peers.push(peer);
  peer.send(handshakeRequest(token, role, `handshake-${suffix}`));
  const handshake = await peer.next();
  expect(handshake).toMatchObject({
    id: `handshake-${suffix}`,
    result: { role },
  });
  peer.sessionId = (handshake as { result: { sessionId: string } }).result.sessionId;
  return peer;
}

function workspace(adapterId = "adapter_vscode_1", workspaceId = "ws_fixture_1") {
  return {
    workspaceId,
    adapterId,
    name: "fixture",
    roots: [
      {
        rootId: "root_fixture_1",
        name: "fixture",
        uri: "file:///workspace/fixture/",
      },
    ],
    workspaceEpoch: 1,
    trust: "trusted",
  } as const;
}

function registerRequest(
  adapterId = "adapter_vscode_1",
  registeredWorkspace = workspace(adapterId),
  extraCapabilities: Record<string, object> = {},
) {
  return {
    jsonrpc: "2.0",
    id: "register-1",
    method: "ide/register",
    params: {
      adapterId,
      name: "ide-bridge-vscode",
      version: "0.1.0",
      ideKind: "vscode",
      ideVersion: "1.125.0",
      positionEncodings: ["utf-16"],
      capabilities: {
        "document/read": { support: "native", guarantee: "semantic" },
        "refactor/prepareRename": {
          support: "native",
          guarantee: "semantic",
          preview: true,
          atomicity: "text-only",
        },
        "symbol/getDefinition": { support: "native", guarantee: "semantic" },
        "workspace/applyPlan": { support: "native", atomicity: "text-only" },
        "workspace/discardPlan": { support: "native" },
        "workspace/undo": { support: "native", atomicity: "text-only" },
        ...extraCapabilities,
      },
      workspaces: [registeredWorkspace],
    },
  } as const;
}

async function registerAdapter(
  adapter: JsonPeer,
  extraCapabilities: Record<string, object> = {},
): Promise<void> {
  adapter.send(registerRequest("adapter_vscode_1", workspace(), extraCapabilities));
  await expect(adapter.next()).resolves.toMatchObject({
    id: "register-1",
    result: {
      adapter: { adapterId: "adapter_vscode_1" },
      workspaces: [{ workspaceId: "ws_fixture_1" }],
    },
  });
}

function documentResult(uri: string, text: string) {
  return {
    document: {
      workspaceId: "ws_fixture_1",
      rootId: "root_fixture_1",
      uri,
      revision: {
        editorVersion: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        workspaceEpoch: 1,
      },
      positionEncoding: "utf-16",
      languageId: "typescript",
      isDirty: false,
    },
    text,
  };
}

function documentSymbolsResult(
  uri: string,
  sessionId: string,
  options: {
    adapterId?: string;
    duplicate?: boolean;
    locatorUri?: string;
    validUntilEpoch?: number;
  } = {},
) {
  const symbol = {
    handle: {
      adapterId: options.adapterId ?? "adapter_vscode_1",
      sessionId,
      id: "sym_fixture_1",
      validUntilEpoch: options.validUntilEpoch ?? 1,
    },
    locator: {
      documentUri: options.locatorUri ?? uri,
      name: "value",
      kind: "variable",
      selectionRange: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 18 },
      },
      positionEncoding: "utf-16",
      fingerprint: `sha256:${"b".repeat(64)}`,
    },
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 20 },
    },
    children: [],
  };
  return {
    document: documentResult(uri, "export const value = 1;\n").document,
    symbols: options.duplicate ? [symbol, structuredClone(symbol)] : [symbol],
  };
}

function fixtureLocator(uri: string) {
  return {
    documentUri: uri,
    name: "value",
    kind: "variable",
    selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
    positionEncoding: "utf-16",
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
}

/** Strips the editor version, modelling a document no editor holds open (ADR-0020). */
function withoutEditorVersion(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy["editorVersion"];
  return copy;
}

function locationFixture(uri: string) {
  return {
    uri,
    range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } },
    positionEncoding: "utf-16",
  };
}

function searchSymbolsResult(
  uri: string,
  sessionId: string,
  options: {
    adapterId?: string;
    count?: number;
    duplicate?: boolean;
    locatorUri?: string;
    nested?: boolean;
    validUntilEpoch?: number;
  } = {},
) {
  const template = documentSymbolsResult(uri, sessionId, options).symbols[0] as Record<
    string,
    unknown
  >;
  const symbols = Array.from({ length: options.count ?? 1 }, (_, index) => {
    const symbol = structuredClone(template);
    if (!options.duplicate) {
      (symbol["handle"] as { id: string }).id = `sym_fixture_${String(index)}`;
    }
    if (options.nested === true) {
      symbol["children"] = [structuredClone(template)];
    }
    return symbol;
  });
  return { symbols, truncated: false };
}

function deeplyNestedDocumentSymbolsResult(uri: string, sessionId: string) {
  const result = documentSymbolsResult(uri, sessionId);
  let nested = result.symbols[0];
  for (let depth = 0; depth < 65; depth += 1) {
    nested = {
      ...structuredClone(result.symbols[0]),
      handle: {
        ...structuredClone(result.symbols[0]?.handle),
        id: `sym_nested_${String(depth)}`,
      },
      children: nested === undefined ? [] : [nested],
    };
  }
  return { ...result, symbols: nested === undefined ? [] : [nested] };
}

function modifiedDocument(
  uri: string,
  editorVersion: number,
  beforeHashCharacter: string,
  afterHashCharacter: string,
) {
  return {
    document: {
      workspaceId: "ws_fixture_1",
      rootId: "root_fixture_1",
      uri,
      revision: {
        editorVersion,
        contentHash: `sha256:${afterHashCharacter.repeat(64)}`,
        workspaceEpoch: 1,
      },
      positionEncoding: "utf-16",
      languageId: "typescript",
      isDirty: true,
    },
    beforeHash: `sha256:${beforeHashCharacter.repeat(64)}`,
    afterHash: `sha256:${afterHashCharacter.repeat(64)}`,
  };
}

function prepareRenameRequest(id: string, uri: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "refactor/prepareRename",
    params: {
      workspaceId: "ws_fixture_1",
      symbol: {
        locator: {
          documentUri: uri,
          name: "a",
          kind: "variable",
          selectionRange: {
            start: { line: 0, character: 13 },
            end: { line: 0, character: 14 },
          },
          positionEncoding: "utf-16",
          fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      newName: "renamed",
      options: { includeComments: false, includeStrings: false },
    },
  } as const;
}

function preparedRenamePlan(planId: string, sessionId: string, uri: string) {
  return {
    planId,
    adapterId: "adapter_vscode_1",
    sessionId,
    workspaceId: "ws_fixture_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operation: "rename",
    guarantee: "semantic",
    atomicity: "text-only",
    preconditions: [
      {
        type: "documentRevision",
        uri,
        editorVersion: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        workspaceEpoch: 1,
      },
    ],
    changes: [{ kind: "textEdit", uri, editCount: 1 }],
    warnings: [],
  } as const;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), milliseconds);
  });
}

describe("daemon session registry and application routing", () => {
  it("registers an adapter and serves canonical local registry methods", async () => {
    const { server, token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);

    consumer.send({ jsonrpc: "2.0", id: "list", method: "workspace/list", params: {} });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "list",
      result: { workspaces: [{ workspaceId: "ws_fixture_1" }] },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "status",
      method: "workspace/getStatus",
      params: { workspaceId: "ws_fixture_1" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "status",
      result: {
        status: { workspaceId: "ws_fixture_1", state: "initializing" },
      },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "capabilities",
      method: "ide/getCapabilities",
      params: { adapterId: "adapter_vscode_1", workspaceId: "ws_fixture_1" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "capabilities",
      result: {
        adapterId: "adapter_vscode_1",
        workspaceId: "ws_fixture_1",
        capabilities: { "document/read": { support: "native" } },
      },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "unsupported",
      method: "document/getSymbols",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "unsupported",
      error: { data: { code: "CAPABILITY_UNAVAILABLE" } },
    });
    expect(adapter.queuedMessageCount).toBe(0);
    expect(server.registry).toMatchObject({
      sessionCount: 2,
      adapterCount: 1,
      workspaceCount: 1,
    });
  });

  it("rejects cross-adapter workspace claims and role violations", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");

    adapter.send(registerRequest("adapter_vscode_1", workspace("adapter_other")));
    await expect(adapter.next()).resolves.toMatchObject({
      id: "register-1",
      error: { data: { code: "PRECONDITION_FAILED" } },
    });
    consumer.send(registerRequest());
    await expect(consumer.next()).resolves.toMatchObject({
      id: "register-1",
      error: { data: { code: "PERMISSION_DENIED" } },
    });
    adapter.send({ jsonrpc: "2.0", id: "admin", method: "bridge/getStatus", params: {} });
    await expect(adapter.next()).resolves.toMatchObject({
      id: "admin",
      error: { data: { code: "PERMISSION_DENIED" } },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "apply-without-store",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: "plan_missing" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-without-store",
      error: { data: { code: "WORKSPACE_NOT_FOUND" } },
    });
  });

  it("tells a consumer that its own edit invalidated the plan", async () => {
    // TASK.md §30 step 12, reproduced where it can be reproduced. Driving it through a real VS Code
    // answered `PLAN_NOT_FOUND` — indistinguishable from a mistyped id — after four other
    // explanations had been measured and ruled out. This asks the daemon the same question directly:
    // prepare, tell it the document changed, apply.
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const adapterSessionId = adapter.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare-stale", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: { plan: preparedRenamePlan("plan_stale_internal", adapterSessionId, uri) },
    });
    const prepared = (await consumer.next()) as { result: { plan: { planId: string } } };

    // The document changes underneath the plan, announced the way an adapter announces it.
    adapter.send({
      jsonrpc: "2.0",
      method: "document/changed",
      params: { document: documentResult(uri, "edited after the plan was prepared").document },
    });
    await delay(50);

    consumer.send({
      jsonrpc: "2.0",
      id: "apply-stale",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: prepared.result.plan.planId },
    });

    // The daemon relays document events to consumers, so the next frame is not necessarily the
    // answer — reading it as one is how this test first "failed".
    let answer = (await consumer.next()) as Record<string, unknown>;
    while (answer["id"] !== "apply-stale")
      answer = (await consumer.next()) as Record<string, unknown>;

    expect(answer).toMatchObject({
      id: "apply-stale",
      error: {
        data: {
          code: "STALE_DOCUMENT",
          retryable: false,
          // The revision the document now has is the part a caller can act on: re-read exactly
          // this, prepare again.
          details: { documentUri: uri },
        },
      },
    });
    // Nothing was sent to the adapter: a plan that cannot be applied must not reach the IDE.
    expect(adapter.queuedMessageCount).toBe(0);
  });

  it("owns prepare/apply/undo identities and consumes each authorization once", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    expect(adapter.sessionId).toBeDefined();
    expect(consumer.sessionId).toBeDefined();
    const adapterSessionId = adapter.sessionId as string;
    const consumerSessionId = consumer.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    expect(routedPrepare).toMatchObject({ method: "refactor/prepareRename" });
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: {
        plan: preparedRenamePlan("plan_adapter_internal", adapterSessionId, uri),
      },
    });
    const prepareResponse = (await consumer.next()) as {
      result: { plan: { planId: string; sessionId: string } };
    };
    const publicPlan = prepareResponse.result.plan;
    expect(publicPlan).toMatchObject({ sessionId: consumerSessionId });
    expect(publicPlan.planId).not.toBe("plan_adapter_internal");

    consumer.send({
      jsonrpc: "2.0",
      id: "apply",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: publicPlan.planId },
    });
    const routedApply = (await adapter.next()) as Record<string, unknown>;
    expect(routedApply).toMatchObject({
      method: "workspace/applyPlan",
      params: { planId: "plan_adapter_internal" },
    });
    adapter.send({
      jsonrpc: "2.0",
      id: routedApply["id"],
      result: {
        modifiedDocuments: [modifiedDocument(uri, 2, "a", "b")],
        undoToken: {
          id: "undo_adapter_internal",
          adapterId: "adapter_vscode_1",
          sessionId: adapterSessionId,
          workspaceId: "ws_fixture_1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const applyResponse = (await consumer.next()) as {
      result: { undoToken: { id: string; sessionId: string } };
    };
    const publicUndoToken = applyResponse.result.undoToken;
    expect(publicUndoToken).toMatchObject({ sessionId: consumerSessionId });
    expect(publicUndoToken.id).not.toBe("undo_adapter_internal");

    consumer.send({
      jsonrpc: "2.0",
      id: "apply-replay",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: publicPlan.planId },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-replay",
      error: { data: { code: "PLAN_NOT_FOUND" } },
    });
    expect(adapter.queuedMessageCount).toBe(0);

    consumer.send({
      jsonrpc: "2.0",
      id: "undo",
      method: "workspace/undo",
      params: { workspaceId: "ws_fixture_1", undoToken: publicUndoToken },
    });
    const routedUndo = (await adapter.next()) as Record<string, unknown>;
    expect(routedUndo).toMatchObject({
      method: "workspace/undo",
      params: {
        undoToken: {
          id: "undo_adapter_internal",
          sessionId: adapterSessionId,
        },
      },
    });
    adapter.send({
      jsonrpc: "2.0",
      id: routedUndo["id"],
      result: { modifiedDocuments: [modifiedDocument(uri, 3, "b", "a")] },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "undo",
      result: { modifiedDocuments: [{ afterHash: `sha256:${"a".repeat(64)}` }] },
    });

    consumer.send({
      jsonrpc: "2.0",
      id: "undo-replay",
      method: "workspace/undo",
      params: { workspaceId: "ws_fixture_1", undoToken: publicUndoToken },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "undo-replay",
      error: { data: { code: "PLAN_NOT_FOUND" } },
    });
    expect(adapter.queuedMessageCount).toBe(0);

    consumer.send(prepareRenameRequest("prepare-discard", uri));
    const routedPrepareForDiscard = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepareForDiscard["id"],
      result: {
        plan: preparedRenamePlan("plan_discard_internal", adapterSessionId, uri),
      },
    });
    const discardPreparation = (await consumer.next()) as {
      result: { plan: { planId: string } };
    };
    consumer.send({
      jsonrpc: "2.0",
      id: "discard",
      method: "workspace/discardPlan",
      params: {
        workspaceId: "ws_fixture_1",
        planId: discardPreparation.result.plan.planId,
      },
    });
    const routedDiscard = (await adapter.next()) as Record<string, unknown>;
    expect(routedDiscard).toMatchObject({
      method: "workspace/discardPlan",
      params: { planId: "plan_discard_internal" },
    });
    adapter.send({
      jsonrpc: "2.0",
      id: routedDiscard["id"],
      result: { planId: "plan_discard_internal", discarded: true },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "discard",
      result: { planId: discardPreparation.result.plan.planId, discarded: true },
    });
  });

  it("fails closed when an apply result does not match its prepared document set", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const adapterSessionId = adapter.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare-invalid-result", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: {
        plan: preparedRenamePlan("plan_invalid_result", adapterSessionId, uri),
      },
    });
    const prepared = (await consumer.next()) as { result: { plan: { planId: string } } };
    consumer.send({
      jsonrpc: "2.0",
      id: "apply-invalid-result",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: prepared.result.plan.planId },
    });
    const routedApply = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedApply["id"],
      result: {
        modifiedDocuments: [
          modifiedDocument("file:///workspace/fixture/unplanned.ts", 2, "a", "b"),
        ],
      },
    });
    const first = await consumer.next();
    const second = await consumer.next();
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "apply-invalid-result",
          error: expect.objectContaining({
            data: expect.objectContaining({ code: "PROVIDER_FAILED" }),
          }),
        }),
        expect.objectContaining({
          method: "adapter/disconnected",
          params: { adapterId: "adapter_vscode_1", reason: "error" },
        }),
      ]),
    );
  });

  // A close frame carries at most 123 bytes of reason. Over that, `close()` throws instead of
  // truncating, the session stays open, and an adapter that just violated the contract keeps its
  // connection — so the explanation has to yield to the disconnection, not the other way round.
  it("disconnects with a reason that fits a close frame when the named condition is long", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const adapterSessionId = adapter.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare-long-reason", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: { plan: preparedRenamePlan("plan_long_reason", adapterSessionId, uri) },
    });
    const prepared = (await consumer.next()) as { result: { plan: { planId: string } } };
    consumer.send({
      jsonrpc: "2.0",
      id: "apply-long-reason",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: prepared.result.plan.planId },
    });
    const routedApply = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedApply["id"],
      result: {
        modifiedDocuments: [
          modifiedDocument("file:///workspace/fixture/unplanned.ts", 2, "a", "b"),
        ],
      },
    });

    const { code, reason } = await adapter.closed;
    expect(code).toBe(1008);
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(123);
    // Truncated, but still naming the rule that refused it rather than only the code.
    expect(reason).toContain("PROVIDER_FAILED (a document was modified");
  });

  // `refactor/prepare` sat in PLAN_STORE_METHODS — which excludes it from ROUTED_METHODS — with no
  // dispatch case of its own, so it fell through and returned nothing at all: no route, no response,
  // and not even the route timeout that would have made the silence visible. A consumer waited
  // forever. Every other method here is covered by a routing test; this one was not, which is
  // exactly why it went unnoticed until an IDE run hung on it.
  it("routes refactor/prepare to the adapter instead of swallowing it", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "refactor/prepare": { support: "native" },
    });

    consumer.send({
      jsonrpc: "2.0",
      id: "prepare-generic",
      method: "refactor/prepare",
      params: {
        workspaceId: "ws_fixture_1",
        operation: "quickFix",
        uri: "file:///workspace/fixture/a.ts",
        arguments: { fixId: "abc123" },
      },
    });

    // The assertion that would have caught the defect: the adapter must be asked at all.
    const routed = (await adapter.next()) as Record<string, unknown>;
    expect(routed["method"]).toBe("refactor/prepare");

    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: {
        plan: preparedRenamePlan(
          "plan_generic",
          adapter.sessionId as string,
          "file:///workspace/fixture/a.ts",
        ),
      },
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "prepare-generic",
      result: { plan: { operation: "rename" } },
    });
  });

  // Added because `refactor/prepare` was a routed method with no routing test, and it swallowed
  // every request from the day it existed — no route, no response, not even the route timeout.
  // These two were added the same way, so they get the check that would have caught it.
  it.each([
    {
      method: "workspace/searchTodos",
      params: { workspaceId: "ws_fixture_1" },
      result: { items: [], truncated: false },
    },
    {
      method: "workspace/listBookmarks",
      params: { workspaceId: "ws_fixture_1" },
      result: { bookmarks: [], truncated: false },
    },
  ])(
    "routes $method to the adapter instead of swallowing it",
    async ({ method, params, result }) => {
      const { token, endpoint } = await startDaemon();
      const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
      const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
      await registerAdapter(adapter, { [method]: { support: "native" } });

      consumer.send({ jsonrpc: "2.0", id: "routed", method, params });

      const routed = (await adapter.next()) as Record<string, unknown>;
      expect(routed["method"]).toBe(method);

      adapter.send({ jsonrpc: "2.0", id: routed["id"], result });

      await expect(consumer.next()).resolves.toMatchObject({ id: "routed", result });
    },
  );

  it("rewrites colliding consumer IDs and restores them on out-of-order responses", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const firstConsumer = await connectPeer(endpoint, token, "consumer", "consumer-a");
    const secondConsumer = await connectPeer(endpoint, token, "consumer", "consumer-b");
    await registerAdapter(adapter);

    firstConsumer.send({
      jsonrpc: "2.0",
      id: "same-id",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    secondConsumer.send({
      jsonrpc: "2.0",
      id: "same-id",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/b.ts" },
    });
    const firstRouted = (await adapter.next()) as Record<string, unknown>;
    const secondRouted = (await adapter.next()) as Record<string, unknown>;
    expect(firstRouted["id"]).not.toBe("same-id");
    expect(secondRouted["id"]).not.toBe("same-id");
    expect(firstRouted["id"]).not.toBe(secondRouted["id"]);

    const routedByUri = new Map(
      [firstRouted, secondRouted].map((request) => [
        (request["params"] as { uri: string }).uri,
        request,
      ]),
    );
    const firstRequest = routedByUri.get("file:///workspace/fixture/a.ts");
    const secondRequest = routedByUri.get("file:///workspace/fixture/b.ts");
    adapter.send({
      jsonrpc: "2.0",
      id: secondRequest?.["id"],
      result: documentResult("file:///workspace/fixture/b.ts", "export const b = 2;\n"),
    });
    adapter.send({
      jsonrpc: "2.0",
      id: firstRequest?.["id"],
      result: documentResult("file:///workspace/fixture/a.ts", "export const a = 1;\n"),
    });

    await expect(secondConsumer.next()).resolves.toMatchObject({
      id: "same-id",
      result: { text: "export const b = 2;\n" },
    });
    await expect(firstConsumer.next()).resolves.toMatchObject({
      id: "same-id",
      result: { text: "export const a = 1;\n" },
    });
  });

  it("enforces cancellation ownership and absorbs one valid late adapter response", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const owner = await connectPeer(endpoint, token, "consumer", "owner");
    const other = await connectPeer(endpoint, token, "consumer", "other");
    await registerAdapter(adapter);

    owner.send({
      jsonrpc: "2.0",
      id: "owned-request",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    other.send({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: "owned-request" },
    });
    await delay(15);
    expect(adapter.queuedMessageCount).toBe(0);

    owner.send({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: "owned-request" },
    });
    await expect(adapter.next()).resolves.toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: routed["id"] },
    });
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: documentResult("file:///workspace/fixture/a.ts", "late\n"),
    });
    await delay(15);
    expect(owner.queuedMessageCount).toBe(0);

    owner.send({ jsonrpc: "2.0", id: "health", method: "bridge/getStatus", params: {} });
    await expect(owner.next()).resolves.toMatchObject({
      id: "health",
      result: { adapterCount: 1 },
    });
  });

  it("rejects symbol handles bound to another adapter session before routing", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);

    consumer.send({
      jsonrpc: "2.0",
      id: "foreign-handle",
      method: "symbol/getDefinition",
      params: {
        workspaceId: "ws_fixture_1",
        symbol: {
          handle: {
            adapterId: "adapter_other",
            sessionId: "session_other",
            id: "foreign-handle",
            validUntilEpoch: 1,
          },
        },
      },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "foreign-handle",
      error: { data: { code: "STALE_SYMBOL" } },
    });
    expect(adapter.queuedMessageCount).toBe(0);

    consumer.send({
      jsonrpc: "2.0",
      id: "expired-handle",
      method: "symbol/getDefinition",
      params: {
        workspaceId: "ws_fixture_1",
        symbol: {
          handle: {
            adapterId: "adapter_vscode_1",
            sessionId: adapter.sessionId,
            id: "expired-handle",
            validUntilEpoch: 0,
          },
        },
      },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "expired-handle",
      error: { data: { code: "STALE_SYMBOL" } },
    });
    expect(adapter.queuedMessageCount).toBe(0);
  });

  it("times out routed work and forwards cancellation to the bound adapter", async () => {
    const { token, endpoint } = await startDaemon({ routeTimeoutMs: 20 });
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);

    consumer.send({
      jsonrpc: "2.0",
      id: "slow-request",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    await expect(consumer.next()).resolves.toMatchObject({
      id: "slow-request",
      error: { data: { code: "TIMEOUT", retryable: true } },
    });
    await expect(adapter.next()).resolves.toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: routed["id"] },
    });
  });

  it("applies authorized readiness notifications and broadcasts them to consumers", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const notification = {
      jsonrpc: "2.0",
      method: "workspace/readinessChanged",
      params: {
        status: {
          workspaceId: "ws_fixture_1",
          state: "ready",
          capabilitiesUnavailable: [],
          progress: { known: true, percentage: 100 },
        },
      },
    };
    adapter.send(notification);
    await expect(consumer.next()).resolves.toEqual(notification);

    consumer.send({
      jsonrpc: "2.0",
      id: "status",
      method: "workspace/getStatus",
      params: { workspaceId: "ws_fixture_1" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "status",
      result: { status: { state: "ready", progress: { percentage: 100 } } },
    });
  });

  it("rejects document notifications whose revision is outside registered roots", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    await registerAdapter(adapter);
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      adapter.socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    adapter.send({
      jsonrpc: "2.0",
      method: "document/changed",
      params: {
        document: documentResult("file:///outside/secret.ts", "secret").document,
      },
    });

    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("rejects a routed document result that does not match the requested URI", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    consumer.send({
      jsonrpc: "2.0",
      id: "exact-document",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: documentResult("file:///workspace/fixture/b.ts", "wrong file\n"),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "exact-document",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
  });

  it.each([
    {
      name: "foreign handle session",
      result: (uri: string) => documentSymbolsResult(uri, "session_foreign"),
    },
    {
      name: "future handle epoch",
      result: (uri: string, sessionId: string) =>
        documentSymbolsResult(uri, sessionId, { validUntilEpoch: 2 }),
    },
    {
      name: "foreign locator URI",
      result: (uri: string, sessionId: string) =>
        documentSymbolsResult(uri, sessionId, {
          locatorUri: "file:///workspace/fixture/other.ts",
        }),
    },
    {
      name: "duplicate handle ID",
      result: (uri: string, sessionId: string) =>
        documentSymbolsResult(uri, sessionId, { duplicate: true }),
    },
    {
      name: "excessive tree depth",
      result: (uri: string, sessionId: string) => deeplyNestedDocumentSymbolsResult(uri, sessionId),
    },
  ])("closes an adapter returning document symbols with $name", async ({ result }) => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "document/getSymbols": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "invalid-symbols",
      method: "document/getSymbols",
      params: { workspaceId: "ws_fixture_1", uri },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: result(uri, adapter.sessionId as string),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "invalid-symbols",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  // These paths caught the error and threw it away, closing with a fixed string. An adapter author
  // learned that a symbol payload was rejected but never which rule — the same silent refusal that
  // cost six wrong explanations on the edit path.
  it("names the failed rule when closing over an invalid symbol payload", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "document/getSymbols": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "unnamed-symbols",
      method: "document/getSymbols",
      params: { workspaceId: "ws_fixture_1", uri },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      // A symbol pointing at a document other than the one asked about.
      result: documentSymbolsResult("file:///workspace/fixture/b.ts", adapter.sessionId as string),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "unnamed-symbols",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    const { code, reason } = await close;
    expect(code).toBe(1008);
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(123);
    expect(reason).toContain("answered about a different document");
  });

  it("routes a valid workspace symbol search across roots", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "workspace/searchSymbols": { support: "provider", guarantee: "semantic" },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "search-ok",
      method: "workspace/searchSymbols",
      params: { workspaceId: "ws_fixture_1", query: "value", limit: 5 },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: searchSymbolsResult("file:///workspace/fixture/a.ts", adapter.sessionId as string, {
        count: 3,
      }),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "search-ok",
      result: { truncated: false, symbols: expect.any(Array) },
    });
  });

  it.each([
    {
      name: "foreign handle session",
      result: (uri: string) => searchSymbolsResult(uri, "session_foreign"),
    },
    {
      name: "mismatched handle epoch",
      result: (uri: string, sessionId: string) =>
        searchSymbolsResult(uri, sessionId, { validUntilEpoch: 2 }),
    },
    {
      name: "locator outside every registered root",
      result: (uri: string, sessionId: string) =>
        searchSymbolsResult(uri, sessionId, { locatorUri: "file:///elsewhere/secret.ts" }),
    },
    {
      name: "duplicate handle ID",
      result: (uri: string, sessionId: string) =>
        searchSymbolsResult(uri, sessionId, { count: 2, duplicate: true }),
    },
    {
      name: "more hits than the requested limit",
      result: (uri: string, sessionId: string) => searchSymbolsResult(uri, sessionId, { count: 3 }),
    },
    {
      name: "nested children in a flat result",
      result: (uri: string, sessionId: string) =>
        searchSymbolsResult(uri, sessionId, { nested: true }),
    },
  ])("closes an adapter returning search symbols with $name", async ({ result }) => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "workspace/searchSymbols": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "invalid-search",
      method: "workspace/searchSymbols",
      params: { workspaceId: "ws_fixture_1", query: "value", limit: 2 },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: result(uri, adapter.sessionId as string),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "invalid-search",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("caps an unlimited search at the shared default limit", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "workspace/searchSymbols": { support: "provider", guarantee: "semantic" },
    });
    consumer.send({
      jsonrpc: "2.0",
      id: "search-default",
      method: "workspace/searchSymbols",
      params: { workspaceId: "ws_fixture_1", query: "value" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: searchSymbolsResult("file:///workspace/fixture/a.ts", adapter.sessionId as string, {
        count: IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT + 1,
      }),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "search-default",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("routes valid symbol locations and a resolved symbol", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "symbol/getReferences": { support: "provider", guarantee: "semantic" },
      "symbol/resolveAt": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send({
      jsonrpc: "2.0",
      id: "refs-ok",
      method: "symbol/getReferences",
      params: { workspaceId: "ws_fixture_1", symbol: { locator: fixtureLocator(uri) } },
    });
    const routedRefs = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedRefs["id"],
      result: { locations: [{ location: locationFixture(uri) }], truncated: false },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "refs-ok",
      result: { locations: [{ location: { uri } }] },
    });

    consumer.send({
      jsonrpc: "2.0",
      id: "resolve-ok",
      method: "symbol/resolveAt",
      params: {
        workspaceId: "ws_fixture_1",
        uri,
        position: { line: 0, character: 14 },
        positionEncoding: "utf-16",
      },
    });
    const routedResolve = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedResolve["id"],
      result: {
        document: documentResult(uri, "export const value = 1;\n").document,
        symbol: documentSymbolsResult(uri, adapter.sessionId as string).symbols[0],
      },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "resolve-ok",
      result: { symbol: { locator: { documentUri: uri } } },
    });
  });

  it.each([
    {
      name: "a location outside every registered root",
      result: () => ({
        locations: [{ location: locationFixture("file:///elsewhere/secret.ts") }],
        truncated: false,
      }),
    },
    {
      name: "an embedded symbol owned by another session",
      result: (uri: string) => ({
        locations: [
          {
            location: locationFixture(uri),
            symbol: documentSymbolsResult(uri, "session_foreign").symbols[0],
          },
        ],
        truncated: false,
      }),
    },
    {
      name: "an embedded symbol carrying a mismatched epoch",
      result: (uri: string, sessionId: string) => ({
        locations: [
          {
            location: locationFixture(uri),
            symbol: documentSymbolsResult(uri, sessionId, { validUntilEpoch: 7 }).symbols[0],
          },
        ],
        truncated: false,
      }),
    },
    {
      name: "more locations than the shared ceiling",
      result: (uri: string) => ({
        locations: Array.from({ length: IDEBP_MAX_SYMBOL_LOCATIONS + 1 }, () => ({
          location: locationFixture(uri),
        })),
        truncated: false,
      }),
    },
  ])("closes an adapter returning symbol locations with $name", async ({ result }) => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "symbol/getReferences": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "invalid-refs",
      method: "symbol/getReferences",
      params: { workspaceId: "ws_fixture_1", symbol: { locator: fixtureLocator(uri) } },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: result(uri, adapter.sessionId as string),
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "invalid-refs",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("closes an adapter resolving a position to a symbol in another document", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "symbol/resolveAt": { support: "provider", guarantee: "semantic" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "resolve-foreign",
      method: "symbol/resolveAt",
      params: {
        workspaceId: "ws_fixture_1",
        uri,
        position: { line: 0, character: 14 },
        positionEncoding: "utf-16",
      },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: {
        document: documentResult(uri, "export const value = 1;\n").document,
        symbol: documentSymbolsResult(uri, adapter.sessionId as string, {
          locatorUri: "file:///workspace/fixture/other.ts",
        }).symbols[0],
      },
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "resolve-foreign",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it.each([
    {
      name: "a document outside every registered root",
      result: () => ({
        documents: [
          {
            document: documentResult("file:///elsewhere/secret.ts", "x\n").document,
            diagnostics: [],
          },
        ],
        capturedAt: "2026-08-02T09:15:00.000Z",
        truncated: false,
      }),
    },
    {
      name: "related information pointing outside the workspace",
      result: (uri: string) => ({
        documents: [
          {
            document: documentResult(uri, "x\n").document,
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                positionEncoding: "utf-16",
                severity: "error",
                message: "leaky",
                relatedInformation: [
                  {
                    location: {
                      uri: "file:///elsewhere/secret.ts",
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                      positionEncoding: "utf-16",
                    },
                    message: "external",
                  },
                ],
              },
            ],
          },
        ],
        capturedAt: "2026-08-02T09:15:00.000Z",
        truncated: false,
      }),
    },
    {
      name: "the same document reported twice",
      result: (uri: string) => ({
        documents: [
          { document: documentResult(uri, "x\n").document, diagnostics: [] },
          { document: documentResult(uri, "x\n").document, diagnostics: [] },
        ],
        capturedAt: "2026-08-02T09:15:00.000Z",
        truncated: false,
      }),
    },
  ])("closes an adapter returning a diagnostics snapshot with $name", async ({ result }) => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, {
      "diagnostics/getSnapshot": { support: "native" },
    });
    const uri = "file:///workspace/fixture/a.ts";
    consumer.send({
      jsonrpc: "2.0",
      id: "invalid-diagnostics",
      method: "diagnostics/getSnapshot",
      params: { workspaceId: "ws_fixture_1" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = adapter.closed;
    adapter.send({ jsonrpc: "2.0", id: routed["id"], result: result(uri) });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "invalid-diagnostics",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("refuses a diagnostics/changed notification naming a document outside the workspace", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const close = adapter.closed;

    adapter.send({
      jsonrpc: "2.0",
      method: "diagnostics/changed",
      params: {
        workspaceId: "ws_fixture_1",
        documentUri: "file:///elsewhere/secret.ts",
        revision: {
          editorVersion: 1,
          contentHash: `sha256:${"a".repeat(64)}`,
          workspaceEpoch: 1,
        },
      },
    });

    await expect(close).resolves.toMatchObject({ code: 1008 });
    // Closing the adapter broadcasts adapter/disconnected; what must never reach the consumer is
    // the notification naming a path outside its workspace.
    await expect(consumer.next()).resolves.toMatchObject({ method: "adapter/disconnected" });
    expect(consumer.queuedMessageCount).toBe(0);
  });

  it("broadcasts a diagnostics/changed notification for a document inside the workspace", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);

    adapter.send({
      jsonrpc: "2.0",
      method: "diagnostics/changed",
      params: {
        workspaceId: "ws_fixture_1",
        documentUri: "file:///workspace/fixture/a.ts",
        revision: {
          editorVersion: 2,
          contentHash: `sha256:${"a".repeat(64)}`,
          workspaceEpoch: 1,
        },
      },
    });

    await expect(consumer.next()).resolves.toMatchObject({
      method: "diagnostics/changed",
      params: { documentUri: "file:///workspace/fixture/a.ts" },
    });
  });

  it("never writes routed diagnostic content to the structured log", async () => {
    const lines: string[] = [];
    const { token, endpoint } = await startDaemon({
      logger: new StructuredLogger({ level: "debug", sink: (line) => lines.push(line) }),
    });
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter, { "diagnostics/getSnapshot": { support: "native" } });
    const uri = "file:///workspace/fixture/a.ts";
    const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI-diagnostic-payload";

    consumer.send({
      jsonrpc: "2.0",
      id: "diagnostics-redaction",
      method: "diagnostics/getSnapshot",
      params: { workspaceId: "ws_fixture_1" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routed["id"],
      result: {
        documents: [
          {
            document: documentResult(uri, "x\n").document,
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                positionEncoding: "utf-16",
                severity: "error",
                message: secret,
                source: secret,
              },
            ],
          },
        ],
        capturedAt: "2026-08-02T09:15:00.000Z",
        truncated: false,
      },
    });

    // The consumer receives the diagnostic in full — that is the point of the method.
    await expect(consumer.next()).resolves.toMatchObject({
      id: "diagnostics-redaction",
      result: { documents: [{ diagnostics: [{ message: secret }] }] },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(uri);
  });

  it("applies a plan prepared against on-disk documents, which carry no editor version", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const adapterSessionId = adapter.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare-disk", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    const plan = preparedRenamePlan("plan_disk", adapterSessionId, uri) as Record<string, unknown>;
    // A file that no editor holds open: the precondition rests on the content hash alone.
    const preconditions = (plan["preconditions"] as Record<string, unknown>[]).map((entry) =>
      withoutEditorVersion(entry),
    );
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: { plan: { ...plan, preconditions } },
    });
    const prepared = (await consumer.next()) as { result: { plan: { planId: string } } };

    consumer.send({
      jsonrpc: "2.0",
      id: "apply-disk",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: prepared.result.plan.planId },
    });
    const routedApply = (await adapter.next()) as Record<string, unknown>;
    const modified = modifiedDocument(uri, 2, "a", "b") as Record<string, unknown>;
    const document = modified["document"] as Record<string, unknown>;
    const revision = document["revision"] as Record<string, unknown>;
    const diskRevision = withoutEditorVersion(revision);
    adapter.send({
      jsonrpc: "2.0",
      id: routedApply["id"],
      result: {
        modifiedDocuments: [
          { ...modified, document: { ...document, revision: diskRevision, isDirty: false } },
        ],
      },
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-disk",
      result: { modifiedDocuments: [{ document: { uri } }] },
    });
  });

  it("still rejects an apply whose editor version did not advance when both sides have one", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const adapterSessionId = adapter.sessionId as string;
    const uri = "file:///workspace/fixture/a.ts";

    consumer.send(prepareRenameRequest("prepare-stale", uri));
    const routedPrepare = (await adapter.next()) as Record<string, unknown>;
    adapter.send({
      jsonrpc: "2.0",
      id: routedPrepare["id"],
      result: { plan: preparedRenamePlan("plan_stale", adapterSessionId, uri) },
    });
    const prepared = (await consumer.next()) as { result: { plan: { planId: string } } };

    consumer.send({
      jsonrpc: "2.0",
      id: "apply-stale",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: prepared.result.plan.planId },
    });
    const routedApply = (await adapter.next()) as Record<string, unknown>;
    // The precondition recorded editorVersion 1; reporting 1 again means nothing was applied.
    adapter.send({
      jsonrpc: "2.0",
      id: routedApply["id"],
      result: { modifiedDocuments: [modifiedDocument(uri, 1, "a", "b")] },
    });

    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-stale",
      error: { data: { code: "PROVIDER_FAILED" } },
    });
  });

  it("applies a trust grant to the registry and unblocks writes that were refused", async () => {
    const { server, token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    const untrusted = { ...workspace(), trust: "untrusted" } as const;
    adapter.send(registerRequest("adapter_vscode_1", untrusted));
    await adapter.next();

    // Before the grant, an apply is refused on trust alone.
    consumer.send({
      jsonrpc: "2.0",
      id: "apply-untrusted",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: "plan_absent" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-untrusted",
      error: { data: { code: "PERMISSION_DENIED" } },
    });

    adapter.send({
      jsonrpc: "2.0",
      method: "workspace/trustChanged",
      params: { workspaceId: "ws_fixture_1", adapterId: "adapter_vscode_1", trust: "trusted" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      method: "workspace/trustChanged",
      params: { trust: "trusted" },
    });
    await expect.poll(() => server.registry.getWorkspace("ws_fixture_1").trust).toBe("trusted");

    // The trust gate no longer fires; the request now fails on the plan itself.
    consumer.send({
      jsonrpc: "2.0",
      id: "apply-trusted",
      method: "workspace/applyPlan",
      params: { workspaceId: "ws_fixture_1", planId: "plan_absent" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "apply-trusted",
      error: { data: { code: "PLAN_NOT_FOUND" } },
    });
  });

  it("refuses a trust change announced for a workspace another adapter owns", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    const close = adapter.closed;

    adapter.send({
      jsonrpc: "2.0",
      method: "workspace/trustChanged",
      params: { workspaceId: "ws_fixture_1", adapterId: "adapter_other", trust: "trusted" },
    });

    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it("accepts a revisionless deletion and refuses one naming a path outside the workspace", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);

    adapter.send({
      jsonrpc: "2.0",
      method: "document/deleted",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/gone.ts" },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      method: "document/deleted",
      params: { uri: "file:///workspace/fixture/gone.ts" },
    });

    const close = adapter.closed;
    adapter.send({
      jsonrpc: "2.0",
      method: "document/deleted",
      params: { workspaceId: "ws_fixture_1", uri: "file:///elsewhere/secret.ts" },
    });
    await expect(close).resolves.toMatchObject({ code: 1008 });
  });

  it.each(["symbol/getDefinition", "symbol/getReferences", "symbol/getImplementations"])(
    "routes %s through the one shared locations shape",
    async (method) => {
      const { token, endpoint } = await startDaemon();
      const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
      const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
      await registerAdapter(adapter, {
        [method]: { support: "provider", guarantee: "semantic" },
      });
      const uri = "file:///workspace/fixture/a.ts";

      consumer.send({
        jsonrpc: "2.0",
        id: `lookup-${method}`,
        method,
        params: { workspaceId: "ws_fixture_1", symbol: { locator: fixtureLocator(uri) } },
      });
      const routed = (await adapter.next()) as Record<string, unknown>;
      adapter.send({
        jsonrpc: "2.0",
        id: routed["id"],
        result: { locations: [{ location: locationFixture(uri) }], truncated: false },
      });

      // The three lookups share `symbolLocationsResponseBase`; a divergent shape on any one of
      // them would be rejected here rather than reaching the consumer.
      await expect(consumer.next()).resolves.toMatchObject({
        id: `lookup-${method}`,
        result: { locations: [{ location: { uri } }], truncated: false },
      });
    },
  );

  it("fails active routes and removes ownership when an adapter disconnects", async () => {
    const { server, token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    consumer.send({
      jsonrpc: "2.0",
      id: "pending",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    await adapter.next();
    adapter.terminate();

    const first = await consumer.next();
    const second = await consumer.next();
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending",
          error: expect.objectContaining({
            data: expect.objectContaining({ code: "ADAPTER_DISCONNECTED" }),
          }),
        }),
        expect.objectContaining({
          method: "adapter/disconnected",
          params: { adapterId: "adapter_vscode_1", reason: "transport-lost" },
        }),
      ]),
    );
    await expect.poll(() => server.registry.adapterCount).toBe(0);
    expect(server.registry.workspaceCount).toBe(0);
  });

  it("expires an unresponsive adapter, cleans its routes, and preserves a live consumer", async () => {
    let currentTime = new Date("2026-08-01T12:00:00.000Z");
    const { server, token, endpoint } = await startDaemon({
      heartbeatIntervalMs: 60_000,
      maxMissedHeartbeats: 2,
      now: () => currentTime,
    });
    const adapter = await connectPeer(endpoint, token, "adapter", "expired-adapter", false);
    const consumer = await connectPeer(endpoint, token, "consumer", "live-consumer");
    await registerAdapter(adapter);
    consumer.send({
      jsonrpc: "2.0",
      id: "pending-expiration",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    await adapter.next();

    for (let sweep = 0; sweep < 3; sweep += 1) {
      currentTime = new Date(currentTime.getTime() + 1_000);
      server.sweepSessions();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect.poll(() => server.registry.adapterCount).toBe(0);
    await expect(adapter.closed).resolves.toEqual({ code: 1001, reason: "Session expired" });
    await expect.poll(() => consumer.queuedMessageCount).toBeGreaterThanOrEqual(2);
    const first = await consumer.next();
    const second = await consumer.next();
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending-expiration",
          error: expect.objectContaining({
            data: expect.objectContaining({ code: "ADAPTER_DISCONNECTED" }),
          }),
        }),
        expect.objectContaining({
          method: "adapter/disconnected",
          params: { adapterId: "adapter_vscode_1", reason: "session-expired" },
        }),
      ]),
    );
    await expect.poll(() => server.registry.adapterCount).toBe(0);
    expect(server.registry.workspaceCount).toBe(0);
    expect(server.registry.sessionCount).toBe(1);
    expect(server.registry.listSessions()[0]?.lastActivityAt).toBe(currentTime.toISOString());

    consumer.send({ jsonrpc: "2.0", id: "still-live", method: "bridge/getStatus", params: {} });
    await expect(consumer.next()).resolves.toMatchObject({
      id: "still-live",
      result: { sessionCount: 1, adapterCount: 0 },
    });
  });

  it("emits redacted composed-daemon lifecycle and RPC records", async () => {
    const lines: string[] = [];
    let monotonic = 100;
    const logger = new StructuredLogger({
      sink: (line) => lines.push(line),
      correlationKey: new Uint8Array(32).fill(9),
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      monotonicNow: () => monotonic,
    });
    const { server, token, endpoint } = await startDaemon({ logger });
    const consumer = await connectPeer(endpoint, token, "consumer", "logging");
    const sourceSecret = "complete-source-secret";
    const replacementSecret = "complete-replacement-secret";
    const diagnosticSecret = "sensitive-diagnostic-secret";
    monotonic = 105;
    consumer.send({
      jsonrpc: "2.0",
      id: token,
      method: "bridge/getStatus",
      params: {
        sourceText: sourceSecret,
        replacementText: replacementSecret,
        diagnostics: [{ message: diagnosticSecret }],
      },
    });
    await expect(consumer.next()).resolves.toMatchObject({
      id: token,
      error: { data: { code: "INVALID_REQUEST" } },
    });
    await expect
      .poll(() => lines.some((line) => line.includes("rpc.message.processed")))
      .toBe(true);

    const serialized = lines.join("");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(sourceSecret);
    expect(serialized).not.toContain(replacementSecret);
    expect(serialized).not.toContain(diagnosticSecret);
    expect(serialized).toContain('"event":"daemon.started"');
    expect(serialized).toContain('"event":"session.opened"');
    expect(serialized).toContain('"event":"rpc.message.processed"');
    expect(serialized).toContain('"method":"bridge/getStatus"');
    expect(serialized).toMatch(/"requestId":"request_[A-Za-z0-9_-]{22}"/u);

    consumer.socket.close(1000, "done");
    await consumer.closed;
    await expect.poll(() => lines.some((line) => line.includes("session.closed"))).toBe(true);
    await server.close();
    expect(lines.join("")).toContain('"event":"daemon.stopped"');
  });

  it("closes an adapter that returns a result for the wrong routed method", async () => {
    const { token, endpoint } = await startDaemon();
    const adapter = await connectPeer(endpoint, token, "adapter", "adapter");
    const consumer = await connectPeer(endpoint, token, "consumer", "consumer");
    await registerAdapter(adapter);
    consumer.send({
      jsonrpc: "2.0",
      id: "pending",
      method: "document/read",
      params: { workspaceId: "ws_fixture_1", uri: "file:///workspace/fixture/a.ts" },
    });
    const routed = (await adapter.next()) as Record<string, unknown>;
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      adapter.socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    adapter.send({ jsonrpc: "2.0", id: routed["id"], result: { workspaces: [] } });
    await expect(close).resolves.toMatchObject({ code: 1002 });
    const first = await consumer.next();
    const second = await consumer.next();
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending",
          error: expect.objectContaining({
            data: expect.objectContaining({ code: "ADAPTER_DISCONNECTED" }),
          }),
        }),
        expect.objectContaining({
          method: "adapter/disconnected",
          params: { adapterId: "adapter_vscode_1", reason: "error" },
        }),
      ]),
    );
  });
});
