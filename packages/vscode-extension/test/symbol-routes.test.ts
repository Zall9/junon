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
import { VscodeSymbolRoutes } from "../src/symbol-routes.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const documentUri = "file:///workspace/project/src/service.ts";

function uri(value: string): VscodeDocumentUriLike {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: decodeURIComponent(parsed.pathname),
    toString: () => value,
  };
}

function fixture(providerResult: unknown, workspaceSearchResult: unknown = []) {
  const folder: VscodeWorkspaceFolderLike = {
    name: "project",
    uri: uri("file:///workspace/project"),
  };
  const model = new VscodeWorkspaceModel(
    "adapter_symbol_routes" as AdapterId,
    "ws_symbol_routes" as WorkspaceId,
    () => "root_symbol_routes" as RootId,
  );
  const workspace = model.snapshot([folder], { trusted: true })[0]!;
  let version = 9;
  const document: VscodeTextDocumentLike = {
    uri: uri(documentUri),
    get version() {
      return version;
    },
    languageId: "typescript",
    isDirty: true,
    getText: () => "export class Service { run(): void {} }\n",
  };
  const documentRoutes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        candidate.toString().startsWith("file:///workspace/project/") ? folder : undefined,
      openTextDocument: async () => document,
    },
    workspaceModel: model,
    currentWorkspace: () => workspace,
  });
  const provideDocumentSymbols = vi.fn(async () => providerResult);
  const provideWorkspaceSymbols = vi.fn(async () => workspaceSearchResult);
  let currentWorkspace = workspace;
  const routes = new VscodeSymbolRoutes({
    adapterId: "adapter_symbol_routes" as AdapterId,
    documentRoutes,
    provider: { provideDocumentSymbols, provideWorkspaceSymbols },
    currentWorkspace: () => currentWorkspace,
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
  const invoke = async (signal = new AbortController().signal) =>
    await handlers.get("document/getSymbols")?.(
      { workspaceId: "ws_symbol_routes", uri: documentUri } as never,
      {
        id: "symbols_request",
        method: "document/getSymbols",
        sessionId: "session_physical" as SessionId,
        signal,
      } as never,
    );
  const invokeSearch = async (
    params: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) =>
    await handlers.get("workspace/searchSymbols")?.(
      { workspaceId: "ws_symbol_routes", query: "Service", ...params } as never,
      {
        id: "search_request",
        method: "workspace/searchSymbols",
        sessionId: "session_physical" as SessionId,
        signal,
      } as never,
    );
  return {
    dispose,
    handlers,
    invoke,
    invokeSearch,
    provideDocumentSymbols,
    provideWorkspaceSymbols,
    routes,
    setVersion(nextVersion: number) {
      version = nextVersion;
    },
    reprojectWorkspace() {
      currentWorkspace = { ...workspace, workspaceEpoch: workspace.workspaceEpoch + 1 };
    },
  };
}

function searchHit(name: string, documentUri: string, kind = 4) {
  return {
    name,
    kind,
    containerName: "",
    location: {
      uri: uri(documentUri),
      range: { start: { line: 2, character: 6 }, end: { line: 2, character: 6 + name.length } },
    },
  };
}

function symbolResult() {
  return [
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
      children: [
        {
          name: "run",
          kind: 5,
          range: {
            start: { line: 0, character: 23 },
            end: { line: 0, character: 37 },
          },
          selectionRange: {
            start: { line: 0, character: 23 },
            end: { line: 0, character: 26 },
          },
          children: [],
        },
      ],
    },
  ];
}

describe("VS Code document symbol route", () => {
  it("returns a validated tree bound to the physical adapter session", async () => {
    const state = fixture(symbolResult());

    await expect(state.invoke()).resolves.toMatchObject({
      document: {
        workspaceId: "ws_symbol_routes",
        uri: documentUri,
        revision: { editorVersion: 9, workspaceEpoch: 0 },
      },
      symbols: [
        {
          handle: {
            adapterId: "adapter_symbol_routes",
            sessionId: "session_physical",
            validUntilEpoch: 0,
          },
          locator: { name: "Service", kind: "class", documentUri },
          children: [
            {
              locator: { name: "run", kind: "method", containerName: "Service" },
            },
          ],
        },
      ],
    });
    expect(state.provideDocumentSymbols).toHaveBeenCalledWith(documentUri);
    state.dispose();
    expect(state.handlers).toHaveLength(0);
  });

  it("returns CAPABILITY_UNAVAILABLE only when no provider result exists", async () => {
    const state = fixture(undefined);
    await expect(state.invoke()).rejects.toMatchObject({
      data: {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: "document/getSymbols" },
      },
    } satisfies ExpectedAdapterError);
  });

  it("normalizes malformed provider output, provider failures, and cancellation", async () => {
    const malformed = fixture([{ name: "missing-ranges", kind: 12 }]);
    await expect(malformed.invoke()).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);

    const failed = fixture(symbolResult());
    failed.provideDocumentSymbols.mockRejectedValueOnce(new Error("provider details"));
    await expect(failed.invoke()).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);

    const cancelled = fixture(symbolResult());
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.invoke(controller.signal)).rejects.toMatchObject({
      data: { code: "CANCELLED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(cancelled.provideDocumentSymbols).not.toHaveBeenCalled();
  });

  it("rejects symbols when the document changes during provider execution", async () => {
    const state = fixture(symbolResult());
    state.provideDocumentSymbols.mockImplementationOnce(async () => {
      state.setVersion(10);
      return symbolResult();
    });

    await expect(state.invoke()).rejects.toMatchObject({
      data: {
        code: "STALE_DOCUMENT",
        retryable: false,
        details: {
          workspaceId: "ws_symbol_routes",
          documentUri,
          currentRevision: { editorVersion: 10, workspaceEpoch: 0 },
        },
      },
    } satisfies ExpectedAdapterError);
  });
});

describe("VS Code workspace symbol search route", () => {
  it("returns flat session-bound hits and drops out-of-root matches without truncating", async () => {
    const state = fixture(symbolResult(), [
      searchHit("Service", documentUri),
      searchHit("Service", "file:///workspace/other/node_modules/lib/index.d.ts"),
      searchHit("ServiceHelper", "file:///workspace/project/src/helper.ts", 11),
    ]);

    await expect(state.invokeSearch()).resolves.toEqual({
      truncated: false,
      symbols: [
        expect.objectContaining({
          handle: expect.objectContaining({
            adapterId: "adapter_symbol_routes",
            sessionId: "session_physical",
            validUntilEpoch: 0,
          }),
          locator: expect.objectContaining({ name: "Service", kind: "class", documentUri }),
          children: [],
        }),
        expect.objectContaining({
          locator: expect.objectContaining({
            name: "ServiceHelper",
            kind: "function",
            documentUri: "file:///workspace/project/src/helper.ts",
          }),
        }),
      ],
    });
    expect(state.provideWorkspaceSymbols).toHaveBeenCalledWith("Service");
  });

  it("drops in-scope hits with no range and reports the result as incomplete", async () => {
    const rangeless = {
      name: "Service",
      kind: 4,
      containerName: "",
      location: { uri: uri(documentUri) },
    };
    const state = fixture(symbolResult(), [rangeless, searchHit("Other", documentUri)]);

    const result = (await state.invokeSearch()) as { symbols: unknown[]; truncated: boolean };
    expect(result.symbols).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("caps results at the effective limit and marks them truncated", async () => {
    const hits = Array.from({ length: 5 }, (_, index) =>
      searchHit(`Service${String(index)}`, documentUri),
    );
    const state = fixture(symbolResult(), hits);

    const result = (await state.invokeSearch({ limit: 2 })) as {
      symbols: unknown[];
      truncated: boolean;
    };
    expect(result.symbols).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("applies the requested kind filter without reporting truncation", async () => {
    const state = fixture(symbolResult(), [
      searchHit("Service", documentUri, 4),
      searchHit("run", documentUri, 5),
    ]);

    const result = (await state.invokeSearch({ kinds: ["method"] })) as {
      symbols: { locator: { name: string } }[];
      truncated: boolean;
    };
    expect(result.symbols.map((symbol) => symbol.locator.name)).toEqual(["run"]);
    expect(result.truncated).toBe(false);
  });

  it("separates absent providers, unknown workspaces, failures, and cancellation", async () => {
    const absent = fixture(symbolResult(), []);
    absent.provideWorkspaceSymbols.mockResolvedValueOnce(undefined);
    await expect(absent.invokeSearch()).rejects.toMatchObject({
      data: {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: "workspace/searchSymbols" },
      },
    } satisfies ExpectedAdapterError);

    const unknown = fixture(symbolResult(), []);
    await expect(unknown.invokeSearch({ workspaceId: "ws_other" })).rejects.toMatchObject({
      data: { code: "WORKSPACE_NOT_FOUND", retryable: false, details: { workspaceId: "ws_other" } },
    } satisfies ExpectedAdapterError);

    const failed = fixture(symbolResult(), []);
    failed.provideWorkspaceSymbols.mockRejectedValueOnce(new Error("provider details"));
    await expect(failed.invokeSearch()).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);

    const cancelled = fixture(symbolResult(), []);
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.invokeSearch({}, controller.signal)).rejects.toMatchObject({
      data: { code: "CANCELLED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(cancelled.provideWorkspaceSymbols).not.toHaveBeenCalled();
  });

  it("refuses to mint handles when the workspace epoch advances during the search", async () => {
    const state = fixture(symbolResult(), [searchHit("Service", documentUri)]);
    state.provideWorkspaceSymbols.mockImplementationOnce(async () => {
      state.reprojectWorkspace();
      return [searchHit("Service", documentUri)];
    });

    await expect(state.invokeSearch()).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});
