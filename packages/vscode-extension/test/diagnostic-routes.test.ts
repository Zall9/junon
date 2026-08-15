import {
  IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT,
  IDEBP_MAX_DIAGNOSTIC_DOCUMENTS,
} from "@ide-bridge/protocol";
import type {
  AdapterId,
  IDEBPRoutedMethod,
  RootId,
  SessionId,
  WorkspaceId,
} from "@ide-bridge/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ExpectedAdapterError } from "./support/expected-error.js";

import { VscodeDiagnosticRoutes } from "../src/diagnostic-routes.js";
import type { VscodeDocumentUriLike, VscodeTextDocumentLike } from "../src/document-mapper.js";
import { VscodeDocumentRoutes } from "../src/document-routes.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const openUri = "file:///workspace/project/src/open.ts";
const closedUri = "file:///workspace/project/src/closed.ts";
const outsideUri = "file:///elsewhere/secret.ts";

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

function diagnostic(message: string, severity = 0, extra: Record<string, unknown> = {}) {
  return { range: range(3, 2, 3, 9), message, severity, ...extra };
}

function fixture(
  options: {
    all?: readonly (readonly [{ toString(): string }, unknown])[];
    byUri?: Record<string, unknown>;
    open?: readonly string[];
    codeActions?: readonly unknown[];
  } = {},
) {
  const folder: VscodeWorkspaceFolderLike = {
    name: "project",
    uri: uri("file:///workspace/project"),
  };
  const model = new VscodeWorkspaceModel(
    "adapter_diag" as AdapterId,
    "ws_diag" as WorkspaceId,
    () => "root_diag" as RootId,
  );
  const workspace = model.snapshot([folder], { trusted: true })[0];
  const document = (value: string): VscodeTextDocumentLike => ({
    uri: uri(value),
    version: 3,
    languageId: "typescript",
    isDirty: false,
    getText: () => "export const value = 1;\n",
  });
  const documentRoutes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        candidate.toString().startsWith("file:///workspace/project/") ? folder : undefined,
      openTextDocument: async (candidate) => document(candidate.toString()),
      readFile: async () => "export const value = 1;\n",
    },
    workspaceModel: model,
    currentWorkspace: () => workspace,
  });
  const byUri = options.byUri ?? { [openUri]: [diagnostic("boom")] };
  const allDiagnostics = vi.fn(() => options.all ?? ([[uri(openUri), byUri[openUri]]] as const));
  const routes = new VscodeDiagnosticRoutes({
    host: {
      allDiagnostics,
      diagnosticsFor: (value) => byUri[value] ?? [],
      provideCodeActions: async () => options.codeActions ?? [],
      openDocumentUris: () => options.open ?? [openUri],
    },
    documentRoutes,
    currentWorkspace: () => workspace,
    now: () => new Date("2026-08-02T09:15:00.000Z"),
  });
  const handlers = new Map<
    IDEBPRoutedMethod,
    (params: never, context: never) => object | Promise<object>
  >();
  routes.attach({
    onRequest: (method, handler) => {
      handlers.set(method, handler as (params: never, context: never) => object | Promise<object>);
      return () => handlers.delete(method);
    },
  });
  const call = async (
    params: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) =>
    await handlers.get("diagnostics/getSnapshot")?.(
      { workspaceId: "ws_diag", ...params } as never,
      {
        id: "diag_request",
        method: "diagnostics/getSnapshot",
        sessionId: "session_physical" as SessionId,
        signal,
      } as never,
    );
  return { call, allDiagnostics };
}

describe("VS Code diagnostics snapshot route", () => {
  it("maps an open document's diagnostics with its exact revision", async () => {
    const state = fixture({
      byUri: {
        [openUri]: [
          diagnostic("Property does not exist", 0, {
            source: "ts",
            code: 2339,
            relatedInformation: [
              {
                location: { uri: uri(openUri), range: range(1, 0, 1, 5) },
                message: "declared here",
              },
            ],
          }),
        ],
      },
    });

    await expect(state.call()).resolves.toMatchObject({
      capturedAt: "2026-08-02T09:15:00.000Z",
      truncated: false,
      documents: [
        {
          document: { workspaceId: "ws_diag", uri: openUri, revision: { editorVersion: 3 } },
          diagnostics: [
            {
              severity: "error",
              message: "Property does not exist",
              source: "ts",
              code: 2339,
              positionEncoding: "utf-16",
              relatedInformation: [{ location: { uri: openUri } }],
            },
          ],
        },
      ],
    });
  });

  it("covers closed documents from disk, without an editor version and without opening them", async () => {
    const state = fixture({
      all: [
        [uri(openUri), [diagnostic("open")]],
        [uri(closedUri), [diagnostic("closed")]],
      ],
      byUri: { [openUri]: [diagnostic("open")], [closedUri]: [diagnostic("closed")] },
      open: [openUri],
    });

    const result = (await state.call()) as {
      documents: { document: { uri: string; revision: Record<string, unknown> } }[];
      truncated: boolean;
    };
    expect(result.documents.map((entry) => entry.document.uri)).toEqual([openUri, closedUri]);
    // The open document carries its editor buffer version; the closed one is identified by hash.
    expect(result.documents[0]?.document.revision).toHaveProperty("editorVersion", 3);
    expect(result.documents[1]?.document.revision).not.toHaveProperty("editorVersion");
    expect(result.documents[1]?.document.revision).toHaveProperty("contentHash");
    expect(result.truncated).toBe(false);
  });

  it("ignores diagnostics for resources outside every registered root", async () => {
    const state = fixture({
      all: [
        [uri(openUri), [diagnostic("inside")]],
        [uri(outsideUri), [diagnostic("outside")]],
      ],
      byUri: { [openUri]: [diagnostic("inside")] },
      open: [openUri, outsideUri],
    });

    const result = (await state.call()) as {
      documents: { document: { uri: string } }[];
      truncated: boolean;
    };
    expect(result.documents.map((entry) => entry.document.uri)).toEqual([openUri]);
    // Out-of-root resources are out of scope, not a missing part of the answer.
    expect(result.truncated).toBe(false);
  });

  it("drops related information pointing outside the workspace", async () => {
    const state = fixture({
      byUri: {
        [openUri]: [
          diagnostic("leaky", 0, {
            relatedInformation: [
              { location: { uri: uri(outsideUri), range: range(1, 0, 1, 5) }, message: "external" },
              { location: { uri: uri(openUri), range: range(2, 0, 2, 5) }, message: "internal" },
            ],
          }),
        ],
      },
    });

    const result = (await state.call()) as {
      documents: { diagnostics: { relatedInformation?: { location: { uri: string } }[] }[] }[];
    };
    const related = result.documents[0]?.diagnostics[0]?.relatedInformation;
    expect(related).toHaveLength(1);
    expect(related?.[0]?.location.uri).toBe(openUri);
  });

  it("refuses an explicit URI outside the workspace instead of silently shrinking the answer", async () => {
    const state = fixture();
    await expect(state.call({ documentUris: [openUri, outsideUri] })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED", retryable: false },
    } satisfies ExpectedAdapterError);
  });

  it("honours an explicit document list even for documents that are not open", async () => {
    const state = fixture({
      byUri: { [closedUri]: [diagnostic("explicitly requested")] },
      open: [],
    });

    const result = (await state.call({ documentUris: [closedUri] })) as {
      documents: { document: { uri: string } }[];
      truncated: boolean;
    };
    expect(result.documents.map((entry) => entry.document.uri)).toEqual([closedUri]);
    expect(result.truncated).toBe(false);
  });

  it("caps documents and per-document diagnostics, reporting both as truncated", async () => {
    const manyUris = Array.from(
      { length: IDEBP_MAX_DIAGNOSTIC_DOCUMENTS + 2 },
      (_, index) => `file:///workspace/project/src/file${String(index)}.ts`,
    );
    const capped = fixture({
      byUri: Object.fromEntries(manyUris.map((value) => [value, [diagnostic("x")]])),
      open: manyUris,
      all: manyUris.map((value) => [uri(value), [diagnostic("x")]] as const),
    });
    const documents = (await capped.call()) as { documents: unknown[]; truncated: boolean };
    expect(documents.documents).toHaveLength(IDEBP_MAX_DIAGNOSTIC_DOCUMENTS);
    expect(documents.truncated).toBe(true);

    const perDocument = fixture({
      byUri: {
        [openUri]: Array.from({ length: IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT + 1 }, () =>
          diagnostic("x"),
        ),
      },
    });
    const single = (await perDocument.call()) as {
      documents: { diagnostics: unknown[] }[];
      truncated: boolean;
    };
    expect(single.documents[0]?.diagnostics).toHaveLength(IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT);
    expect(single.truncated).toBe(true);
  });

  it("skips a malformed diagnostic instead of losing the whole snapshot", async () => {
    const state = fixture({
      byUri: {
        [openUri]: [{ message: "no range" }, diagnostic("valid")],
      },
    });

    const result = (await state.call()) as {
      documents: { diagnostics: { message: string }[] }[];
      truncated: boolean;
    };
    expect(result.documents[0]?.diagnostics.map((entry) => entry.message)).toEqual(["valid"]);
    expect(result.truncated).toBe(true);
  });

  it("maps every severity and defaults an unknown one to error", async () => {
    const state = fixture({
      byUri: {
        [openUri]: [
          diagnostic("e", 0),
          diagnostic("w", 1),
          diagnostic("i", 2),
          diagnostic("h", 3),
          diagnostic("unknown", 9),
        ],
      },
    });

    const result = (await state.call()) as {
      documents: { diagnostics: { severity: string }[] }[];
    };
    expect(result.documents[0]?.diagnostics.map((entry) => entry.severity)).toEqual([
      "error",
      "warning",
      "information",
      "hint",
      "error",
    ]);
  });

  it("rejects an unknown workspace and honours cancellation", async () => {
    const unknown = fixture();
    await expect(unknown.call({ workspaceId: "ws_other" })).rejects.toMatchObject({
      data: { code: "WORKSPACE_NOT_FOUND", retryable: false, details: { workspaceId: "ws_other" } },
    } satisfies ExpectedAdapterError);

    const cancelled = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.call({}, controller.signal)).rejects.toMatchObject({
      data: { code: "CANCELLED", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});
