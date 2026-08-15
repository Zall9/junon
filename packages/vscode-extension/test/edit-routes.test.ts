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
import { codeActionFixId } from "../src/diagnostic-mapper.js";
import { VscodeEditRoutes } from "../src/edit-routes.js";
import { VscodeSymbolHandleRegistry } from "../src/symbol-mapper.js";
import { VscodeSymbolTargetResolver } from "../src/symbol-target.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const primaryUri = "file:///workspace/project/src/service.ts";
const secondaryUri = "file:///workspace/project/src/consumer.ts";
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

function documentSymbols() {
  return [
    {
      name: "Service",
      kind: 4,
      range: range(0, 0, 2, 1),
      selectionRange: range(0, 13, 0, 20),
      children: [],
    },
  ];
}

function locatorFor(name = "Service") {
  return {
    documentUri: primaryUri,
    name,
    kind: "class" as const,
    selectionRange: range(0, 13, 0, 20),
    positionEncoding: "utf-16" as const,
    fingerprint: `sha256:${"c".repeat(64)}`,
  };
}

function fixture(
  options: {
    edit?: readonly (readonly [string, number])[];
    trusted?: boolean;
    applyResult?: boolean;
  } = {},
) {
  const folder: VscodeWorkspaceFolderLike = {
    name: "project",
    uri: uri("file:///workspace/project"),
  };
  const model = new VscodeWorkspaceModel(
    "adapter_edit" as AdapterId,
    "ws_edit" as WorkspaceId,
    () => "root_edit" as RootId,
  );
  const workspace = model.snapshot([folder], { trusted: options.trusted ?? true })[0];
  const contents = new Map<string, string>([
    [primaryUri, "export class Service {}\n"],
    [secondaryUri, "import { Service } from './service';\n"],
  ]);
  const versions = new Map<string, number>([
    [primaryUri, 1],
    [secondaryUri, 1],
  ]);
  const document = (value: string): VscodeTextDocumentLike => ({
    uri: uri(value),
    get version() {
      return versions.get(value) ?? 1;
    },
    languageId: "typescript",
    isDirty: false,
    getText: () => contents.get(value) ?? "",
  });
  const documentRoutes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        candidate.toString().startsWith("file:///workspace/project/") ? folder : undefined,
      openTextDocument: async (candidate) => document(candidate.toString()),
      readFile: async (candidate) => contents.get(candidate.toString()) ?? "",
    },
    workspaceModel: model,
    currentWorkspace: () => workspace,
  });
  const handles = new VscodeSymbolHandleRegistry();
  const resolver = new VscodeSymbolTargetResolver({
    adapterId: "adapter_edit" as AdapterId,
    documentRoutes,
    handles,
    provideDocumentSymbols: async () => documentSymbols(),
  });

  const provideFormatEdits = vi.fn(async (): Promise<unknown> => ({ format: true }));
  // One offer with an edit. `codeActionFixId("quickfix", "Add missing import")` is what a consumer
  // would have been handed by a diagnostics snapshot.
  const provideCodeActions = vi.fn(async (): Promise<unknown> => [
    { title: "Add missing import", kind: { value: "quickfix" }, edit: { fix: true } },
  ]);
  const prepareRename = vi.fn(async (): Promise<unknown> => range(0, 13, 0, 20));
  const provideRenameEdits = vi.fn(async (): Promise<unknown> => ({ kind: "edit" }));
  const describeEdit = vi.fn(
    (): readonly (readonly [string, number])[] =>
      options.edit ?? [[primaryUri, 1] as const, [secondaryUri, 1] as const],
  );
  const applyEdit = vi.fn(async (): Promise<boolean> => {
    // A real apply rewrites the buffers; the fixture mirrors that so hashes actually move.
    for (const [key, value] of contents) contents.set(key, `${value}// renamed\n`);
    for (const [key, value] of versions) versions.set(key, value + 1);
    return options.applyResult ?? true;
  });
  const save = vi.fn(async (): Promise<boolean> => true);

  const routes = new VscodeEditRoutes({
    adapterId: "adapter_edit" as AdapterId,
    documentRoutes,
    handles,
    resolver,
    currentWorkspace: () => workspace,
    host: {
      prepareRename,
      provideRenameEdits,
      provideFormatEdits,
      provideCodeActions,
      describeEdit,
      applyEdit,
      save,
    },
    now: () => new Date("2026-08-02T10:00:00.000Z"),
    createPlanId: () => "plan_fixture_1",
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
      { workspaceId: "ws_edit", ...params } as never,
      {
        id: "edit_request",
        method,
        sessionId: "session_physical" as SessionId,
        signal,
      } as never,
    );

  return {
    applyEdit,
    call,
    contents,
    describeEdit,
    dispose,
    handlers,
    prepareRename,
    provideFormatEdits,
    provideRenameEdits,
    routes,
    save,
    async prepare() {
      return (await call("refactor/prepareRename", {
        symbol: { locator: locatorFor() },
        newName: "Renamed",
        options: { includeComments: false, includeStrings: false },
      })) as { plan: { planId: string; preconditions: { uri: string }[] } };
    },
  };
}

describe("VS Code refactor/prepareRename", () => {
  it("prepares a reformat without touching the document", async () => {
    const state = fixture();

    const prepared = (await state.call("refactor/prepare", {
      operation: "reformat",
      uri: primaryUri,
    })) as { plan: { operation: string; guarantee: string } };

    expect(prepared.plan.operation).toBe("reformat");
    // Formatting rewrites layout, not meaning. Claiming `semantic` would promise the formatter
    // understood the code.
    expect(prepared.plan.guarantee).toBe("syntactic");
    // The whole point of two phases: nothing is written until the plan is applied.
    expect(state.applyEdit).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("prepares a quick fix the consumer chose from a published offer", async () => {
    const state = fixture();

    const prepared = (await state.call("refactor/prepare", {
      operation: "quickFix",
      uri: primaryUri,
      arguments: {
        fixId: codeActionFixId("quickfix", "Add missing import"),
        range: JSON.stringify({ start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }),
      },
    })) as { plan: { operation: string; guarantee: string } };

    expect(prepared.plan.operation).toBe("quickFix");
    // A language service computed the edit, so the word is accurate.
    expect(prepared.plan.guarantee).toBe("semantic");
    expect(state.applyEdit).not.toHaveBeenCalled();
  });

  // The guarantee the whole two-phase design exists for: an offer that is no longer on the table
  // must be refused, never swapped for whatever now sits in its place.
  it("refuses a fix identifier the provider no longer offers", async () => {
    const state = fixture();

    await expect(
      state.call("refactor/prepare", {
        operation: "quickFix",
        uri: primaryUri,
        arguments: {
          fixId: "deadbeef",
          range: JSON.stringify({
            start: { line: 1, character: 0 },
            end: { line: 1, character: 4 },
          }),
        },
      }),
    ).rejects.toMatchObject({ data: { code: "PRECONDITION_FAILED" } });
  });

  it("refuses an operation it does not perform by name", async () => {
    const state = fixture();

    // Refused rather than answered with an empty plan that would apply nothing while reporting
    // success — a consumer must be able to tell "not wired here" from "nothing to do".
    await expect(
      state.call("refactor/prepare", { operation: "extractMethod", uri: primaryUri }),
    ).rejects.toMatchObject({ data: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("produces a plan with one precondition per affected document", async () => {
    const state = fixture();

    const prepared = await state.prepare();

    expect(prepared.plan).toMatchObject({
      adapterId: "adapter_edit",
      sessionId: "session_physical",
      workspaceId: "ws_edit",
      operation: "rename",
      guarantee: "semantic",
      atomicity: "text-only",
      changes: [
        { kind: "textEdit", uri: primaryUri, editCount: 1 },
        { kind: "textEdit", uri: secondaryUri, editCount: 1 },
      ],
    });
    expect(prepared.plan.preconditions.map((entry) => entry.uri)).toEqual([
      primaryUri,
      secondaryUri,
    ]);
    // Applying saves and cannot be undone here, so the plan must say so before anyone applies it.
    expect((prepared.plan as unknown as { warnings: string[] }).warnings[0]).toMatch(
      /cannot be undone/u,
    );
    expect(state.prepareRename).toHaveBeenCalled();
  });

  it("refuses to write in an untrusted workspace at both phases", async () => {
    const state = fixture({ trusted: false });
    await expect(
      state.call("refactor/prepareRename", {
        symbol: { locator: locatorFor() },
        newName: "Renamed",
        options: { includeComments: false, includeStrings: false },
      }),
    ).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.provideRenameEdits).not.toHaveBeenCalled();

    await expect(
      state.call("workspace/applyPlan", { planId: "plan_fixture_1" }),
    ).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED", retryable: false },
    } satisfies ExpectedAdapterError);
  });

  it("refuses a rename the provider says is not possible at that position", async () => {
    const state = fixture();
    state.prepareRename.mockResolvedValueOnce(undefined);

    await expect(
      state.call("refactor/prepareRename", {
        symbol: { locator: locatorFor() },
        newName: "Renamed",
        options: { includeComments: false, includeStrings: false },
      }),
    ).rejects.toMatchObject({
      data: { code: "PRECONDITION_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.provideRenameEdits).not.toHaveBeenCalled();
  });

  it("refuses a plan touching a document outside every registered root", async () => {
    const state = fixture({
      edit: [
        [primaryUri, 1],
        [outsideUri, 1],
      ],
    });

    await expect(
      state.call("refactor/prepareRename", {
        symbol: { locator: locatorFor() },
        newName: "Renamed",
        options: { includeComments: false, includeStrings: false },
      }),
    ).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});

describe("VS Code workspace/applyPlan", () => {
  it("verifies preconditions, applies, saves, and reports moved hashes", async () => {
    const state = fixture();
    const prepared = await state.prepare();

    const result = (await state.call("workspace/applyPlan", {
      planId: prepared.plan.planId,
    })) as {
      modifiedDocuments: { document: { uri: string }; beforeHash: string; afterHash: string }[];
    };

    expect(state.applyEdit).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(result.modifiedDocuments.map((entry) => entry.document.uri)).toEqual([
      primaryUri,
      secondaryUri,
    ]);
    for (const modified of result.modifiedDocuments) {
      expect(modified.beforeHash).not.toBe(modified.afterHash);
    }
    // No undo token: VS Code cannot revert an applied workspace edit (ADR-0021).
    expect(result).not.toHaveProperty("undoToken");
  });

  it("rejects an apply whose document changed after preparation, without writing", async () => {
    const state = fixture();
    const prepared = await state.prepare();
    state.contents.set(primaryUri, "export class Service {} // edited by the user\n");

    await expect(
      state.call("workspace/applyPlan", { planId: prepared.plan.planId }),
    ).rejects.toMatchObject({
      data: { code: "STALE_DOCUMENT", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.applyEdit).not.toHaveBeenCalled();
  });

  it("consumes a plan exactly once", async () => {
    const state = fixture();
    const prepared = await state.prepare();
    await state.call("workspace/applyPlan", { planId: prepared.plan.planId });

    await expect(
      state.call("workspace/applyPlan", { planId: prepared.plan.planId }),
    ).rejects.toMatchObject({
      data: { code: "PLAN_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.applyEdit).toHaveBeenCalledOnce();
  });

  it("treats a refused edit as a failure that wrote nothing", async () => {
    const state = fixture({ applyResult: false });
    const prepared = await state.prepare();

    await expect(
      state.call("workspace/applyPlan", { planId: prepared.plan.planId }),
    ).rejects.toMatchObject({
      data: { code: "PROVIDER_FAILED", retryable: false },
    } satisfies ExpectedAdapterError);
    expect(state.save).not.toHaveBeenCalled();
  });

  it("drops a plan whose document changed, before it can be applied", async () => {
    const state = fixture();
    const prepared = await state.prepare();

    state.routes.invalidateDocument(secondaryUri);

    await expect(
      state.call("workspace/applyPlan", { planId: prepared.plan.planId }),
    ).rejects.toMatchObject({
      data: { code: "PLAN_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);
  });
});

describe("VS Code workspace/discardPlan", () => {
  it("discards a prepared plan and makes it unusable", async () => {
    const state = fixture();
    const prepared = await state.prepare();

    await expect(
      state.call("workspace/discardPlan", { planId: prepared.plan.planId }),
    ).resolves.toEqual({ planId: prepared.plan.planId, discarded: true });

    await expect(
      state.call("workspace/applyPlan", { planId: prepared.plan.planId }),
    ).rejects.toMatchObject({
      data: { code: "PLAN_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);
  });

  it("rejects discarding an unknown plan", async () => {
    const state = fixture();
    await expect(
      state.call("workspace/discardPlan", { planId: "plan_absent" }),
    ).rejects.toMatchObject({
      data: { code: "PLAN_NOT_FOUND", retryable: false },
    } satisfies ExpectedAdapterError);
  });

  it("registers no undo handler, because VS Code cannot revert an applied edit", () => {
    const state = fixture();
    expect(state.handlers.has("workspace/undo")).toBe(false);
    expect([...state.handlers.keys()].sort()).toEqual([
      "refactor/prepare",
      "refactor/prepareRename",
      "workspace/applyPlan",
      "workspace/discardPlan",
    ]);
  });
});
