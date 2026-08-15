import { IDEBP_MAX_SYMBOL_LOCATIONS } from "@ide-bridge/protocol";
import type {
  AdapterId,
  IDEBPRoutedMethod,
  RootId,
  SessionId,
  WorkspaceId,
} from "@ide-bridge/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ExpectedAdapterError } from "./support/expected-error.js";
import type { VscodeDocumentUriLike, VscodeTextDocumentLike } from "../src/document-mapper.js";
import { VscodeDocumentRoutes } from "../src/document-routes.js";
import { VscodeSymbolHandleRegistry, mapVscodeDocumentSymbols } from "../src/symbol-mapper.js";
import { VscodeSymbolNavigationRoutes } from "../src/symbol-navigation-routes.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const documentUri = "file:///workspace/project/src/service.ts";
const otherUri = "file:///workspace/project/src/consumer.ts";

function uri(value: string): VscodeDocumentUriLike {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: decodeURIComponent(parsed.pathname),
    toString: () => value,
  };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

/** One class `Service` (line 0) containing one method `run` (line 1). */
function documentSymbols() {
  return [
    {
      name: "Service",
      kind: 4,
      range: range(0, 0, 2, 1),
      selectionRange: range(0, 13, 0, 20),
      children: [
        {
          name: "run",
          kind: 5,
          range: range(1, 2, 1, 20),
          selectionRange: range(1, 2, 1, 5),
          children: [],
        },
      ],
    },
  ];
}

function location(value: string, line = 5) {
  return { uri: uri(value), range: range(line, 4, line, 7) };
}

function fixture(options: { symbols?: unknown; locations?: unknown } = {}) {
  const folder: VscodeWorkspaceFolderLike = {
    name: "project",
    uri: uri("file:///workspace/project"),
  };
  const model = new VscodeWorkspaceModel(
    "adapter_nav" as AdapterId,
    "ws_nav" as WorkspaceId,
    () => "root_nav" as RootId,
  );
  const workspace = model.snapshot([folder], { trusted: true })[0];
  let version = 4;
  const document: VscodeTextDocumentLike = {
    uri: uri(documentUri),
    get version() {
      return version;
    },
    languageId: "typescript",
    isDirty: false,
    getText: () => "export class Service {\n  run(): void {}\n}\n",
  };
  const documentRoutes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        candidate.toString().startsWith("file:///workspace/project/") ? folder : undefined,
      openTextDocument: async (candidate) => ({ ...document, uri: candidate }),
    },
    workspaceModel: model,
    currentWorkspace: () => workspace,
  });
  const handles = new VscodeSymbolHandleRegistry();
  const provideDocumentSymbols = vi.fn(
    async (): Promise<unknown> => options.symbols ?? documentSymbols(),
  );
  const provideDefinition = vi.fn(
    async (): Promise<unknown> => options.locations ?? [location(otherUri)],
  );
  const provideReferences = vi.fn(
    async (): Promise<unknown> => options.locations ?? [location(otherUri)],
  );
  const provideImplementations = vi.fn(
    async (): Promise<unknown> => options.locations ?? [location(otherUri)],
  );
  // Its own mock rather than an alias of another: the test asserts which relation reached it, and
  // a shared mock could not tell a hierarchy request from an implementations one.
  const provideHierarchy = vi.fn(
    async (): Promise<unknown> => options.locations ?? [location(otherUri)],
  );
  const routes = new VscodeSymbolNavigationRoutes({
    adapterId: "adapter_nav" as AdapterId,
    documentRoutes,
    handles,
    provider: {
      provideDocumentSymbols,
      provideDefinition,
      provideReferences,
      provideImplementations,
      provideHierarchy,
    },
    currentWorkspace: () => workspace,
  });
  const handlers = new Map<
    IDEBPRoutedMethod,
    (params: never, context: never) => object | Promise<object>
  >();
  const dispose = routes.attach({
    onRequest: (method, handler) => {
      handlers.set(method, handler as (params: never, context: never) => object | Promise<object>);
      return () => handlers.delete(method);
    },
  });
  const call = async (
    method: IDEBPRoutedMethod,
    params: Record<string, unknown>,
    signal = new AbortController().signal,
  ) =>
    await handlers.get(method)?.(
      { workspaceId: "ws_nav", ...params } as never,
      {
        id: "nav_request",
        method,
        sessionId: "session_physical" as SessionId,
        signal,
      } as never,
    );

  return {
    call,
    dispose,
    handlers,
    handles,
    provideDefinition,
    provideDocumentSymbols,
    provideHierarchy,
    provideReferences,
    setVersion(next: number) {
      version = next;
    },
    async resolveHandle() {
      const resolved = (await call("symbol/resolveAt", {
        uri: documentUri,
        position: { line: 1, character: 3 },
        positionEncoding: "utf-16",
      })) as { symbol: { handle: unknown; locator: unknown } };
      return resolved.symbol;
    },
  };
}

describe("VS Code symbol/resolveAt route", () => {
  it("resolves the innermost symbol and binds a handle to the physical session", async () => {
    const state = fixture();

    await expect(
      state.call("symbol/resolveAt", {
        uri: documentUri,
        position: { line: 1, character: 3 },
        positionEncoding: "utf-16",
      }),
    ).resolves.toMatchObject({
      document: { workspaceId: "ws_nav", uri: documentUri, revision: { editorVersion: 4 } },
      symbol: {
        handle: { adapterId: "adapter_nav", sessionId: "session_physical", validUntilEpoch: 0 },
        locator: { name: "run", kind: "method", containerName: "Service" },
        children: [],
      },
    });
  });

  it("does not revoke the handles a document symbol query already handed out", async () => {
    const state = fixture();
    const tree = mapVscodeDocumentSymbols(documentSymbols(), documentUri) ?? [];
    state.handles.materialize(tree, {
      adapterId: "adapter_nav" as AdapterId,
      sessionId: "session_physical" as SessionId,
      workspaceId: "ws_nav" as WorkspaceId,
      documentUri,
      editorVersion: 4,
      workspaceEpoch: 0,
    });
    expect(state.handles.size).toBe(2);

    await state.resolveHandle();

    // A point resolution adds its own handle; the document's two remain live.
    expect(state.handles.size).toBe(3);
  });

  it("refuses a position encoding the adapter does not implement", async () => {
    const state = fixture();
    await expect(
      state.call("symbol/resolveAt", {
        uri: documentUri,
        position: { line: 1, character: 3 },
        positionEncoding: "utf-8",
      }),
    ).rejects.toMatchObject({
      data: { code: "INVALID_REQUEST", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.provideDocumentSymbols).not.toHaveBeenCalled();
  });

  it("reports a position covered by no symbol as an ordinary empty result", async () => {
    const state = fixture();
    const result = (await state.call("symbol/resolveAt", {
      uri: documentUri,
      position: { line: 40, character: 0 },
      positionEncoding: "utf-16",
    })) as Record<string, unknown>;

    expect(result).toHaveProperty("document");
    expect(result).not.toHaveProperty("symbol");
    // No handle is minted for an answer that identifies no symbol.
    expect(state.handles.size).toBe(0);
  });

  it("rejects the result when the document changes during provider execution", async () => {
    const state = fixture();
    state.provideDocumentSymbols.mockImplementationOnce(async () => {
      state.setVersion(5);
      return documentSymbols();
    });

    await expect(
      state.call("symbol/resolveAt", {
        uri: documentUri,
        position: { line: 1, character: 3 },
        positionEncoding: "utf-16",
      }),
    ).rejects.toMatchObject({
      data: { code: "STALE_DOCUMENT", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});

describe("VS Code symbol lookup routes", () => {
  it("follows a live handle without re-running the symbol provider", async () => {
    const state = fixture();
    const symbol = await state.resolveHandle();
    state.provideDocumentSymbols.mockClear();

    await expect(
      state.call("symbol/getReferences", { symbol: { handle: symbol.handle } }),
    ).resolves.toEqual({
      truncated: false,
      locations: [
        { location: { uri: otherUri, range: range(5, 4, 5, 7), positionEncoding: "utf-16" } },
      ],
    });
    expect(state.provideDocumentSymbols).not.toHaveBeenCalled();
    // The provider is queried at the symbol's own selection range.
    expect(state.provideReferences).toHaveBeenCalledWith(documentUri, { line: 1, character: 2 });
  });

  it("carries the relation through to the provider and answers with locations", async () => {
    const state = fixture();
    const symbol = await state.resolveHandle();

    await expect(
      state.call("symbol/getHierarchy", {
        symbol: { handle: symbol.handle },
        // Deliberately not "callers". An earlier version asked for callers and passed even when the
        // implementation hardcoded "callers" — it could not tell the relation was being dropped.
        relation: "subtypes",
      }),
    ).resolves.toEqual({
      truncated: false,
      locations: [
        { location: { uri: otherUri, range: range(5, 4, 5, 7), positionEncoding: "utf-16" } },
      ],
    });
    // The relation must reach the provider: dropping it would silently answer every request with
    // callers, which looks correct until a consumer asks for subtypes.
    expect(state.provideHierarchy).toHaveBeenCalledWith(
      documentUri,
      { line: 1, character: 2 },
      "subtypes",
    );
  });

  it("relocates from a locator when the handle is unknown", async () => {
    const state = fixture();
    const symbol = await state.resolveHandle();
    state.handles.invalidateAll();

    await expect(
      state.call("symbol/getDefinition", {
        symbol: { handle: symbol.handle, locator: symbol.locator },
      }),
    ).resolves.toMatchObject({ locations: [{ location: { uri: otherUri } }] });
    expect(state.provideDocumentSymbols).toHaveBeenCalled();
  });

  it("returns STALE_SYMBOL when a dead handle carries no locator to relocate from", async () => {
    const state = fixture();
    const symbol = await state.resolveHandle();
    state.handles.invalidateAll();

    await expect(
      state.call("symbol/getReferences", { symbol: { handle: symbol.handle } }),
    ).rejects.toMatchObject({
      data: { code: "STALE_SYMBOL", retryable: false, details: { workspaceId: "ws_nav" } },
    } satisfies ExpectedAdapterError);
  });

  it("reports candidates instead of guessing between indistinguishable overloads", async () => {
    const overloaded = [
      {
        name: "run",
        kind: 5,
        range: range(1, 2, 1, 20),
        selectionRange: range(1, 2, 1, 5),
        children: [],
      },
      {
        name: "run",
        kind: 5,
        range: range(3, 2, 3, 20),
        selectionRange: range(3, 2, 3, 5),
        children: [],
      },
    ];
    const state = fixture({ symbols: overloaded });

    await expect(
      state.call("symbol/getReferences", {
        symbol: {
          locator: {
            documentUri,
            name: "run",
            kind: "method",
            selectionRange: range(99, 0, 99, 3),
            positionEncoding: "utf-16",
            fingerprint: `sha256:${"d".repeat(64)}`,
          },
        },
      }),
    ).rejects.toMatchObject({
      data: {
        code: "AMBIGUOUS_SYMBOL",
        retryable: false,
        details: { workspaceId: "ws_nav", documentUri, candidates: expect.any(Array) },
      },
    } satisfies ExpectedAdapterError);
  });

  it("refuses a locator pointing outside every registered root", async () => {
    const state = fixture();
    await expect(
      state.call("symbol/getReferences", {
        symbol: {
          locator: {
            documentUri: "file:///elsewhere/secret.ts",
            name: "run",
            kind: "method",
            selectionRange: range(1, 2, 1, 5),
            positionEncoding: "utf-16",
            fingerprint: `sha256:${"e".repeat(64)}`,
          },
        },
      }),
    ).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED", retryable: false },
    } satisfies ExpectedAdapterError);
  });

  it("filters locations outside the workspace and maps LocationLink results", async () => {
    const state = fixture({
      locations: [
        location(otherUri, 5),
        location("file:///workspace/project/node_modules/lib/index.d.ts", 9),
        location("file:///elsewhere/other.ts", 2),
        {
          targetUri: uri(otherUri),
          targetRange: range(20, 0, 30, 1),
          targetSelectionRange: range(20, 6, 20, 9),
        },
      ],
    });
    const symbol = await state.resolveHandle();

    const result = (await state.call("symbol/getImplementations", {
      symbol: { handle: symbol.handle },
    })) as { locations: { location: { uri: string; range: unknown } }[] };

    expect(result.locations.map((entry) => entry.location.uri)).toEqual([
      otherUri,
      "file:///workspace/project/node_modules/lib/index.d.ts",
      otherUri,
    ]);
    // LocationLink prefers the identifier span over the full target range.
    expect(result.locations[2]?.location.range).toEqual(range(20, 6, 20, 9));
  });

  it("reports a capped result as truncated, and root filtering as complete", async () => {
    const overflowing = fixture({
      locations: Array.from({ length: IDEBP_MAX_SYMBOL_LOCATIONS + 5 }, (_, index) =>
        location(otherUri, index),
      ),
    });
    const symbol = await overflowing.resolveHandle();
    const capped = (await overflowing.call("symbol/getReferences", {
      symbol: { handle: symbol.handle },
    })) as { locations: unknown[]; truncated: boolean };

    expect(capped.locations).toHaveLength(IDEBP_MAX_SYMBOL_LOCATIONS);
    expect(capped.truncated).toBe(true);

    // Dropping out-of-root locations is a scope decision, not an incomplete answer.
    const filtered = fixture({
      locations: [location(otherUri), location("file:///elsewhere/other.ts")],
    });
    const filteredSymbol = await filtered.resolveHandle();
    const complete = (await filtered.call("symbol/getReferences", {
      symbol: { handle: filteredSymbol.handle },
    })) as { locations: unknown[]; truncated: boolean };

    expect(complete.locations).toHaveLength(1);
    expect(complete.truncated).toBe(false);
  });

  it("separates an absent provider, a failure, and cancellation", async () => {
    const absent = fixture();
    const symbol = await absent.resolveHandle();
    absent.provideDefinition.mockResolvedValueOnce(undefined);
    await expect(
      absent.call("symbol/getDefinition", { symbol: { handle: symbol.handle } }),
    ).rejects.toMatchObject({
      data: {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: "symbol/getDefinition" },
      },
    } satisfies ExpectedAdapterError);

    const failed = fixture();
    const failedSymbol = await failed.resolveHandle();
    failed.provideDefinition.mockRejectedValueOnce(new Error("provider details"));
    await expect(
      failed.call("symbol/getDefinition", { symbol: { handle: failedSymbol.handle } }),
    ).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);

    const cancelled = fixture();
    const cancelledSymbol = await cancelled.resolveHandle();
    cancelled.provideReferences.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.call(
        "symbol/getReferences",
        { symbol: { handle: cancelledSymbol.handle } },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      data: { code: "CANCELLED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(cancelled.provideReferences).not.toHaveBeenCalled();
  });

  it("rejects an unknown workspace before touching any provider", async () => {
    const state = fixture();
    await expect(
      state.call("symbol/getReferences", {
        workspaceId: "ws_other",
        symbol: { handle: { id: "sym_x" } },
      }),
    ).rejects.toMatchObject({
      data: { code: "WORKSPACE_NOT_FOUND", retryable: false, details: { workspaceId: "ws_other" } },
    } satisfies ExpectedAdapterError);
    expect(state.provideReferences).not.toHaveBeenCalled();
  });
});
