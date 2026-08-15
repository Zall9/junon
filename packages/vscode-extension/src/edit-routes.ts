import {
  BridgeAdapterRequestError,
  MAX_CLIENT_MESSAGE_BYTES,
  type ReconnectingBridgeConnection,
} from "@ide-bridge/bridge-client";
import { isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
import type { SymbolReference } from "@ide-bridge/protocol";
import type { SymbolLocator } from "@ide-bridge/protocol";
import type { SymbolHandle } from "@ide-bridge/protocol";
import type {
  AdapterId,
  DocumentDiagnostics,
  DocumentRevisionPrecondition,
  EditPlan,
  JSONRPCRequestIdentifier,
  ModificationResult,
  ModifiedDocument,
  Revision,
  SessionId,
  Workspace,
} from "@ide-bridge/protocol";

import { codeActionFixId } from "./diagnostic-mapper.js";
import type { VscodeDocumentRoutes } from "./document-routes.js";
import type { VscodeSymbolHandleRegistry } from "./symbol-mapper.js";
import { VscodeSymbolTargetResolver, adapterError, assertNotCancelled } from "./symbol-target.js";

/** Bounds on one rename: a refactor touching more than this is refused rather than attempted. */
const MAX_PLAN_DOCUMENTS = 500;
const MAX_PLAN_EDITS = 10_000;
const PLAN_LIFETIME_MS = 120_000;
const MAX_LIVE_PLANS = 32;

export interface VscodeEditHost {
  /** `vscode.prepareRename`: validates that the position may be renamed at all. */
  prepareRename(uri: string, position: { line: number; character: number }): Promise<unknown>;
  /** `vscode.executeDocumentRenameProvider`: computes the workspace edit. */
  provideRenameEdits(
    uri: string,
    position: { line: number; character: number },
    newName: string,
  ): Promise<unknown>;
  /** Enumerates a workspace edit as `[uri, editCount]` pairs without exposing VS Code objects. */
  describeEdit(edit: unknown): readonly (readonly [string, number])[];
  applyEdit(edit: unknown): Promise<boolean>;
  /**
   * `vscode.executeFormatDocumentProvider`, wrapped as a workspace edit.
   *
   * Computed, not applied — preparing must leave the file untouched, so the formatter's edits are
   * held and applied only when the plan is.
   */
  provideFormatEdits(uri: string): Promise<unknown>;
  /**
   * The code actions offered over a range, for resolving a chosen `fixId` back to its edit.
   *
   * Re-queried at prepare time rather than remembered from the snapshot that published the offer:
   * the document may have moved on, and a stale offer must fail closed rather than apply whatever
   * now occupies its place.
   */
  provideCodeActions(uri: string, range: unknown): Promise<unknown>;
  /** Saves a modified document; resolves false when the editor refused to save it. */
  save(uri: string): Promise<boolean>;
}

export interface VscodeEditRoutesOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  handles: VscodeSymbolHandleRegistry;
  host: VscodeEditHost;
  resolver: VscodeSymbolTargetResolver;
  currentWorkspace(): Workspace | undefined;
  diagnosticsFor?(uris: readonly string[], signal: AbortSignal): Promise<DocumentDiagnostics[]>;
  now?: () => Date;
  createPlanId?: () => string;
}

interface StoredPlan {
  plan: EditPlan;
  edit: unknown;
  sessionId: SessionId;
  workspaceEpoch: number;
  expiresAt: number;
  uris: string[];
}

type AdapterRouteConnection = Pick<ReconnectingBridgeConnection, "onRequest">;

export class VscodeEditRoutes {
  readonly #options: VscodeEditRoutesOptions;
  readonly #now: () => Date;
  readonly #createPlanId: () => string;
  readonly #plans = new Map<string, StoredPlan>();

  constructor(options: VscodeEditRoutesOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#createPlanId =
      options.createPlanId ??
      (() =>
        `plan_${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url")}`);
  }

  attach(connection: AdapterRouteConnection): () => void {
    const disposers = [
      connection.onRequest(
        "refactor/prepareRename",
        async (params, context) => await this.#prepareRename(params, context),
      ),
      connection.onRequest(
        "refactor/prepare",
        async (params, context) => await this.#prepare(params, context),
      ),
      connection.onRequest(
        "workspace/applyPlan",
        async (params, context) => await this.#applyPlan(params, context),
      ),
      connection.onRequest("workspace/discardPlan", (params) => this.#discardPlan(params)),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      this.#plans.clear();
    };
  }

  /** Drops any plan touching a document that changed: its preconditions can no longer hold. */
  invalidateDocument(uri: string): void {
    for (const [planId, stored] of this.#plans) {
      if (stored.uris.includes(uri)) this.#plans.delete(planId);
    }
  }

  invalidateAll(): void {
    this.#plans.clear();
  }

  /**
   * The generic preparation entry point, for operations that are not a rename.
   *
   * Only `reformat` is served. The rest of the vocabulary is refused **by name** rather than
   * ignored: `optimizeImports` and `quickFix` are reachable on this IDE and simply not wired, and
   * the structural refactorings are refused on the JetBrains side too, for the reason ADR-0028
   * measures. A consumer that asks gets a code it can act on instead of silence.
   */
  async #prepare(
    params: Parameters<Parameters<AdapterRouteConnection["onRequest"]>[1]>[0] & {
      workspaceId: Workspace["workspaceId"];
      operation: EditPlan["operation"];
      uri?: string;
    },
    context: { id: JSONRPCRequestIdentifier; sessionId: SessionId; signal: AbortSignal },
  ): Promise<{ plan: EditPlan }> {
    if (params.operation === "quickFix") return await this.#prepareQuickFix(params, context);
    if (params.operation !== "reformat") {
      throw adapterError("CAPABILITY_UNAVAILABLE");
    }
    const workspace = this.#assertWritableWorkspace(params.workspaceId);
    const uri = params.uri;
    if (uri === undefined) throw adapterError("INVALID_REQUEST");

    const revision = await this.#revisionOf(uri, context.signal);
    if (revision === undefined) throw adapterError("DOCUMENT_NOT_FOUND");
    assertNotCancelled(context.signal);

    let edit: unknown;
    try {
      edit = await this.#options.host.provideFormatEdits(uri);
    } catch {
      assertNotCancelled(context.signal);
      throw adapterError("PROVIDER_FAILED");
    }
    assertNotCancelled(context.signal);
    if (edit === undefined || edit === null) {
      // No formatter for this language. Refused by name rather than answered with an empty plan
      // that would apply nothing while reporting success.
      throw adapterError("CAPABILITY_UNAVAILABLE");
    }

    const described = this.#options.host.describeEdit(edit);
    const change = described.find(([target]) => target === uri);
    if (change === undefined) {
      // The formatter returned edits for something other than the document asked about, or none
      // at all. Either way there is nothing this plan can honestly promise.
      throw adapterError("PROVIDER_FAILED");
    }

    this.#sweepExpiredPlans();
    if (this.#plans.size >= MAX_LIVE_PLANS) throw adapterError("PRECONDITION_FAILED");
    const expiresAt = this.#now().getTime() + PLAN_LIFETIME_MS;
    const plan: EditPlan = {
      planId: this.#createPlanId(),
      adapterId: this.#options.adapterId,
      sessionId: context.sessionId,
      workspaceId: workspace.workspaceId,
      expiresAt: new Date(expiresAt).toISOString(),
      operation: "reformat",
      // Formatting rewrites layout, not meaning. Calling it semantic would claim the formatter
      // understood the code, which is a stronger promise than it makes (AGENTS.md §4).
      guarantee: "syntactic",
      atomicity: "text-only",
      preconditions: [{ type: "documentRevision", uri, ...revision }],
      changes: [{ kind: "textEdit", uri, editCount: change[1] }],
      warnings: [
        "Applying this plan saves every modified document to disk and cannot be undone through IDE Bridge on VS Code.",
      ],
    };
    this.#plans.set(plan.planId, {
      plan,
      edit,
      sessionId: context.sessionId,
      workspaceEpoch: workspace.workspaceEpoch,
      expiresAt,
      uris: [uri],
    });
    assertResponseFits(context.id, { plan });
    return { plan };
  }

  /**
   * Prepares a fix the consumer picked from a diagnostic's published offers.
   *
   * The offer is resolved by **re-deriving** its identifier from the actions the provider offers
   * now, never by a handle kept since the snapshot. That makes staleness fail closed for free: if
   * the document changed or the offer is gone, nothing matches and the request is refused instead
   * of applying a different fix that happens to sit in the same position.
   */
  async #prepareQuickFix(
    params: {
      workspaceId: Workspace["workspaceId"];
      uri?: string;
      arguments?: Record<string, string>;
    },
    context: { id: JSONRPCRequestIdentifier; sessionId: SessionId; signal: AbortSignal },
  ): Promise<{ plan: EditPlan }> {
    const workspace = this.#assertWritableWorkspace(params.workspaceId);
    const uri = params.uri;
    const fixId = params.arguments?.["fixId"];
    const rangeArgument = params.arguments?.["range"];
    if (uri === undefined || fixId === undefined || rangeArgument === undefined) {
      throw adapterError("INVALID_REQUEST");
    }

    let range: unknown;
    try {
      range = JSON.parse(rangeArgument);
    } catch {
      throw adapterError("INVALID_REQUEST");
    }

    const revision = await this.#revisionOf(uri, context.signal);
    if (revision === undefined) throw adapterError("DOCUMENT_NOT_FOUND");
    assertNotCancelled(context.signal);

    let actions: unknown;
    try {
      actions = await this.#options.host.provideCodeActions(uri, range);
    } catch {
      assertNotCancelled(context.signal);
      throw adapterError("PROVIDER_FAILED");
    }
    assertNotCancelled(context.signal);

    const offered = Array.isArray(actions) ? (actions as Record<string, unknown>[]) : [];
    const chosen = offered.find((action) => {
      const title = typeof action["title"] === "string" ? action["title"] : undefined;
      if (title === undefined || action["edit"] === undefined || action["edit"] === null) {
        return false;
      }
      const kind = (action["kind"] as { value?: unknown } | undefined)?.value;
      return codeActionFixId(typeof kind === "string" ? kind : "", title) === fixId;
    });
    // The offer no longer exists. Refused rather than substituted — applying a different fix than
    // the one a consumer reviewed is the failure this whole two-phase design exists to prevent.
    if (chosen === undefined) throw adapterError("PRECONDITION_FAILED");

    const edit = chosen["edit"];
    const described = this.#options.host.describeEdit(edit);
    const change = described.find(([target]) => target === uri);
    if (change === undefined) throw adapterError("PROVIDER_FAILED");

    this.#sweepExpiredPlans();
    if (this.#plans.size >= MAX_LIVE_PLANS) throw adapterError("PRECONDITION_FAILED");
    const expiresAt = this.#now().getTime() + PLAN_LIFETIME_MS;
    const plan: EditPlan = {
      planId: this.#createPlanId(),
      adapterId: this.#options.adapterId,
      sessionId: context.sessionId,
      workspaceId: workspace.workspaceId,
      expiresAt: new Date(expiresAt).toISOString(),
      operation: "quickFix",
      // The language service computed the edit, so the word is accurate.
      guarantee: "semantic",
      atomicity: "text-only",
      preconditions: [{ type: "documentRevision", uri, ...revision }],
      changes: [{ kind: "textEdit", uri, editCount: change[1] }],
      warnings: [
        "Applying this plan saves every modified document to disk and cannot be undone through IDE Bridge on VS Code.",
      ],
    };
    this.#plans.set(plan.planId, {
      plan,
      edit,
      sessionId: context.sessionId,
      workspaceEpoch: workspace.workspaceEpoch,
      expiresAt,
      uris: [uri],
    });
    assertResponseFits(context.id, { plan });
    return { plan };
  }

  async #prepareRename(
    params: Parameters<Parameters<AdapterRouteConnection["onRequest"]>[1]>[0] & {
      workspaceId: Workspace["workspaceId"];
      symbol: Parameters<VscodeSymbolTargetResolver["resolve"]>[1]["symbol"];
      newName: string;
    },
    context: { id: JSONRPCRequestIdentifier; sessionId: SessionId; signal: AbortSignal },
  ): Promise<{ plan: EditPlan }> {
    const workspace = this.#assertWritableWorkspace(params.workspaceId);
    const target = await this.#options.resolver.resolve(
      workspace,
      { workspaceId: params.workspaceId, symbol: symbolReference(params.symbol) },
      context.sessionId,
      context.signal,
    );
    assertNotCancelled(context.signal);

    // `prepareRename` is the provider's own answer to "may this position be renamed?". A refusal
    // here is a precondition failure, not a provider malfunction.
    try {
      const preparable = await this.#options.host.prepareRename(
        target.documentUri,
        target.selectionRange.start,
      );
      if (preparable === undefined || preparable === null) {
        throw adapterError("PRECONDITION_FAILED", {
          workspaceId: params.workspaceId,
          documentUri: target.documentUri,
        });
      }
    } catch (error) {
      if (error instanceof BridgeAdapterRequestError) throw error;
      assertNotCancelled(context.signal);
      throw adapterError("PRECONDITION_FAILED", {
        workspaceId: params.workspaceId,
        documentUri: target.documentUri,
      });
    }
    assertNotCancelled(context.signal);

    let edit: unknown;
    try {
      edit = await this.#options.host.provideRenameEdits(
        target.documentUri,
        target.selectionRange.start,
        params.newName,
      );
    } catch {
      assertNotCancelled(context.signal);
      throw adapterError("PROVIDER_FAILED");
    }
    assertNotCancelled(context.signal);
    if (edit === undefined || edit === null) {
      throw new BridgeAdapterRequestError({
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: "refactor/prepareRename" },
      });
    }

    let described: readonly (readonly [string, number])[];
    try {
      described = this.#options.host.describeEdit(edit);
    } catch {
      throw adapterError("PROVIDER_FAILED");
    }
    if (described.length === 0) throw adapterError("PROVIDER_FAILED");
    if (
      described.length > MAX_PLAN_DOCUMENTS ||
      described.reduce((total, [, count]) => total + count, 0) > MAX_PLAN_EDITS
    ) {
      throw adapterError("PRECONDITION_FAILED", { workspaceId: params.workspaceId });
    }
    for (const [uri] of described) {
      if (!workspace.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri))) {
        throw adapterError("PERMISSION_DENIED");
      }
    }

    const collected: DocumentRevisionPrecondition[] = [];
    for (const [uri] of described) {
      const revision = await this.#revisionOf(uri, context.signal);
      if (revision === undefined) {
        throw adapterError("PRECONDITION_FAILED", {
          workspaceId: params.workspaceId,
          documentUri: uri,
        });
      }
      collected.push({ type: "documentRevision", uri, ...revision });
    }
    const changeSummaries = described.map(([uri, editCount]) => ({
      kind: "textEdit" as const,
      uri,
      editCount,
    }));
    // The schema requires at least one of each; the empty case was already refused above.
    const [firstPrecondition, ...otherPreconditions] = collected;
    const [firstChange, ...otherChanges] = changeSummaries;
    if (firstPrecondition === undefined || firstChange === undefined) {
      throw adapterError("PROVIDER_FAILED");
    }

    this.#sweepExpiredPlans();
    if (this.#plans.size >= MAX_LIVE_PLANS) throw adapterError("PRECONDITION_FAILED");
    const expiresAt = this.#now().getTime() + PLAN_LIFETIME_MS;
    const plan: EditPlan = {
      planId: this.#createPlanId(),
      adapterId: this.#options.adapterId,
      sessionId: context.sessionId,
      workspaceId: workspace.workspaceId,
      expiresAt: new Date(expiresAt).toISOString(),
      operation: "rename",
      guarantee: "semantic",
      atomicity: "text-only",
      preconditions: [firstPrecondition, ...otherPreconditions],
      changes: [firstChange, ...otherChanges],
      // Applying saves every modified file and IDEBP offers no undo on this adapter, so the change
      // is irreversible through the protocol. Consumers must be told before they apply.
      warnings: [
        "Applying this plan saves every modified document to disk and cannot be undone through IDE Bridge on VS Code.",
      ],
    };
    this.#plans.set(plan.planId, {
      plan,
      edit,
      sessionId: context.sessionId,
      workspaceEpoch: workspace.workspaceEpoch,
      expiresAt,
      uris: described.map(([uri]) => uri),
    });

    const result = { plan };
    assertResponseFits(context.id, result);
    return result;
  }

  async #applyPlan(
    params: { workspaceId: Workspace["workspaceId"]; planId: string } & {
      includePostApplyDiagnostics?: boolean;
    },
    context: { id: JSONRPCRequestIdentifier; sessionId: SessionId; signal: AbortSignal },
  ): Promise<ModificationResult> {
    const workspace = this.#assertWritableWorkspace(params.workspaceId);
    const stored = this.#consumePlan(params.planId, params.workspaceId, context.sessionId);
    if (stored.workspaceEpoch !== workspace.workspaceEpoch) {
      throw new BridgeAdapterRequestError({ code: "PLAN_EXPIRED", retryable: false });
    }

    // The daemon checks ownership, expiry, and epoch, but never content: the revision
    // preconditions are the adapter's to verify, and they must hold immediately before the edit.
    for (const precondition of stored.plan.preconditions) {
      assertNotCancelled(context.signal);
      const current = await this.#revisionOf(precondition.uri, context.signal);
      if (current === undefined) {
        // The document became unreadable — deleted or moved. There is no current revision to
        // report, so STALE_DOCUMENT, which requires one, would not be truthful.
        throw adapterError("PRECONDITION_FAILED", {
          workspaceId: params.workspaceId,
          documentUri: precondition.uri,
        });
      }
      if (current.contentHash !== precondition.contentHash) {
        throw new BridgeAdapterRequestError({
          code: "STALE_DOCUMENT",
          retryable: false,
          details: {
            workspaceId: params.workspaceId,
            documentUri: precondition.uri,
            currentRevision: current,
          },
        });
      }
    }

    let applied: boolean;
    try {
      applied = await this.#options.host.applyEdit(stored.edit);
    } catch {
      throw adapterError("PROVIDER_FAILED");
    }
    // Text-only workspace edits are all-or-nothing in VS Code, so a false result means nothing was
    // written and PARTIAL_APPLY cannot arise.
    if (!applied) throw adapterError("PROVIDER_FAILED");

    const modifiedDocuments: ModifiedDocument[] = [];
    for (const precondition of stored.plan.preconditions) {
      // Saving runs will-save participants such as format-on-save, which may change the content
      // again. The reported hashes are therefore taken after the save settles, never before.
      await this.#options.host.save(precondition.uri);
      const after = await this.#readDocument(precondition.uri, context.signal);
      if (after === undefined) throw adapterError("PROVIDER_FAILED");
      modifiedDocuments.push({
        document: after,
        beforeHash: precondition.contentHash,
        afterHash: after.revision.contentHash,
      });
    }
    for (const uri of stored.uris)
      this.#options.handles.invalidateDocument(workspace.workspaceId, uri);

    const [firstModified, ...otherModified] = modifiedDocuments;
    if (firstModified === undefined) throw adapterError("PROVIDER_FAILED");
    const diagnostics =
      params.includePostApplyDiagnostics === true
        ? await this.#options.diagnosticsFor?.(stored.uris, context.signal)
        : undefined;
    const result: ModificationResult =
      diagnostics === undefined || diagnostics.length === 0
        ? { modifiedDocuments: [firstModified, ...otherModified] }
        : { modifiedDocuments: [firstModified, ...otherModified], diagnostics };
    assertResponseFits(context.id, result);
    return result;
  }

  #discardPlan(params: { workspaceId: Workspace["workspaceId"]; planId: string }): {
    planId: string;
    discarded: true;
  } {
    const stored = this.#plans.get(params.planId);
    if (stored === undefined || stored.plan.workspaceId !== params.workspaceId) {
      throw new BridgeAdapterRequestError({ code: "PLAN_NOT_FOUND", retryable: false });
    }
    this.#plans.delete(params.planId);
    return { planId: params.planId, discarded: true };
  }

  #consumePlan(planId: string, workspaceId: string, sessionId: SessionId): StoredPlan {
    this.#sweepExpiredPlans();
    const stored = this.#plans.get(planId);
    if (
      stored === undefined ||
      stored.plan.workspaceId !== workspaceId ||
      stored.sessionId !== sessionId
    ) {
      throw new BridgeAdapterRequestError({ code: "PLAN_NOT_FOUND", retryable: false });
    }
    // One shot: removed before the edit runs, so a retry can never replay it.
    this.#plans.delete(planId);
    return stored;
  }

  #sweepExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [planId, stored] of this.#plans) {
      if (stored.expiresAt <= now) this.#plans.delete(planId);
    }
  }

  async #revisionOf(uri: string, signal: AbortSignal): Promise<Revision | undefined> {
    return (await this.#readDocument(uri, signal))?.revision;
  }

  async #readDocument(
    uri: string,
    signal: AbortSignal,
  ): Promise<ModifiedDocument["document"] | undefined> {
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined) return undefined;
    try {
      const content = await this.#options.documentRoutes.read(
        { workspaceId: workspace.workspaceId, uri },
        signal,
      );
      return content.document;
    } catch (error) {
      if (error instanceof BridgeAdapterRequestError && error.data.code === "CANCELLED")
        throw error;
    }
    return (await this.#options.documentRoutes.readFromDisk(uri, signal))?.document;
  }

  #assertWritableWorkspace(workspaceId: Workspace["workspaceId"]): Workspace {
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined || workspace.workspaceId !== workspaceId) {
      throw new BridgeAdapterRequestError({
        code: "WORKSPACE_NOT_FOUND",
        retryable: false,
        details: { workspaceId },
      });
    }
    // Workspace trust is checked at both phases: a workspace can lose trust between preparing and
    // applying, and a plan is not an authorization to write later.
    if (workspace.trust !== "trusted") throw adapterError("PERMISSION_DENIED");
    return workspace;
  }
}

function assertResponseFits(id: JSONRPCRequestIdentifier, result: object): void {
  if (
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8") >
    MAX_CLIENT_MESSAGE_BYTES
  ) {
    throw adapterError("PROVIDER_FAILED");
  }
}

/**
 * Narrows a symbol reference to exactly one of its branches.
 *
 * The schema states a reference as an `anyOf`: a handle, a locator, or both. Under
 * `exactOptionalPropertyTypes` an absent property differs from a present-but-undefined one, so the
 * union has to be rebuilt explicitly rather than spread.
 */
function symbolReference(reference: {
  // `| undefined` on the input, absent on the output: the caller may hand over a
  // present-but-undefined property, the callee may not receive one.
  handle?: SymbolHandle | undefined;
  locator?: SymbolLocator | undefined;
}): SymbolReference {
  if (reference.handle !== undefined && reference.locator !== undefined) {
    return { handle: reference.handle, locator: reference.locator };
  }
  if (reference.handle !== undefined) return { handle: reference.handle };
  if (reference.locator !== undefined) return { locator: reference.locator };
  throw new Error("A symbol reference must carry a handle, a locator, or both");
}
