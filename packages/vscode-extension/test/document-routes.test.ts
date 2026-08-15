import type { AdapterId, IDEBPRoutedMethod, RootId, WorkspaceId } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import type { ExpectedAdapterError } from "./support/expected-error.js";
import type { VscodeDocumentUriLike, VscodeTextDocumentLike } from "../src/document-mapper.js";
import { hashInMemoryContent } from "../src/document-mapper.js";
import { VscodeDocumentRoutes } from "../src/document-routes.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

function uri(value: string): VscodeDocumentUriLike {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: decodeURIComponent(parsed.pathname),
    toString: () => value,
  };
}

function fixture() {
  const folder: VscodeWorkspaceFolderLike = {
    name: "project",
    uri: uri("file:///workspace/project"),
  };
  const model = new VscodeWorkspaceModel(
    "adapter_routes" as AdapterId,
    "ws_routes" as WorkspaceId,
    () => "root_routes" as RootId,
  );
  const workspaces = () => model.snapshot([folder], { trusted: true });
  workspaces();
  let text = "export const value = 1;\n";
  let version = 4;
  const document: VscodeTextDocumentLike = {
    uri: uri("file:///workspace/project/src/value.ts"),
    get version() {
      return version;
    },
    languageId: "typescript",
    isDirty: true,
    getText: () => text,
  };
  const routes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        candidate.toString().startsWith("file:///workspace/project/") ? folder : undefined,
      openTextDocument: async () => document,
    },
    workspaceModel: model,
    currentWorkspace: () => workspaces()[0],
  });
  return {
    document,
    routes,
    setText(nextText: string, nextVersion: number) {
      text = nextText;
      version = nextVersion;
    },
  };
}

describe("VS Code document routes", () => {
  it("reads the exact unsaved buffer and returns its in-memory revision", async () => {
    const { routes } = fixture();
    const result = await routes.read({
      workspaceId: "ws_routes" as WorkspaceId,
      uri: "file:///workspace/project/src/value.ts",
    });

    expect(result).toMatchObject({
      text: "export const value = 1;\n",
      document: {
        workspaceId: "ws_routes",
        rootId: "root_routes",
        uri: "file:///workspace/project/src/value.ts",
        revision: {
          editorVersion: 4,
          contentHash: hashInMemoryContent("export const value = 1;\n"),
        },
        isDirty: true,
      },
    });
  });

  it("attaches both handlers and omits source text from getRevision", async () => {
    const { routes } = fixture();
    const handlers = new Map<
      IDEBPRoutedMethod,
      (params: never, context: never) => object | Promise<object>
    >();
    const dispose = routes.attach({
      onRequest: (method, handler) => {
        handlers.set(
          method,
          handler as (params: never, context: never) => object | Promise<object>,
        );
        return () => handlers.delete(method);
      },
    });
    const handler = handlers.get("document/getRevision");
    expect(handler).toBeDefined();
    const result = await handler?.(
      {
        workspaceId: "ws_routes",
        uri: "file:///workspace/project/src/value.ts",
      } as never,
      {
        id: "route_revision",
        method: "document/getRevision",
        signal: new AbortController().signal,
      } as never,
    );

    expect(result).toHaveProperty("document.revision.editorVersion", 4);
    expect(result).not.toHaveProperty("text");
    dispose();
    expect(handlers).toHaveLength(0);
  });

  it("fails closed for a foreign workspace, non-canonical URI, and cancellation", async () => {
    const { routes } = fixture();
    await expect(
      routes.read({
        workspaceId: "ws_foreign" as WorkspaceId,
        uri: "file:///workspace/project/src/value.ts",
      }),
    ).rejects.toMatchObject({
      data: { code: "WORKSPACE_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);

    await expect(
      routes.read({
        workspaceId: "ws_routes" as WorkspaceId,
        uri: "file:///workspace/project/src/../src/value.ts",
      }),
    ).rejects.toMatchObject({
      data: { code: "DOCUMENT_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      routes.read(
        {
          workspaceId: "ws_routes" as WorkspaceId,
          uri: "file:///workspace/project/src/value.ts",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      data: { code: "CANCELLED", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});
