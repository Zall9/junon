/**
 * Shared resolution of a consumer symbol reference to a concrete document position.
 *
 * Navigation and rename must resolve a reference the same way, or a symbol a consumer can navigate
 * to would be one it cannot rename. Both go through this module: a live handle is the fast path,
 * anything else goes through controlled relocation and fails closed (ADR-0018).
 */

import { BridgeAdapterRequestError } from "@ide-bridge/bridge-client";
import { isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
import type {
  AdapterId,
  DocumentReference,
  DocumentTargetParams,
  Range,
  SessionId,
  SymbolReference,
  Workspace,
  WorkspaceId,
} from "@ide-bridge/protocol";

import type { VscodeDocumentRoutes } from "./document-routes.js";
import {
  VscodeSymbolHandleRegistry,
  mapVscodeDocumentSymbols,
  type SymbolDraft,
} from "./symbol-mapper.js";
import { relocateSymbol } from "./symbol-relocation.js";

export interface SymbolTargetResolverOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  handles: VscodeSymbolHandleRegistry;
  provideDocumentSymbols(uri: string): Promise<unknown>;
}

export interface ResolvedSymbolTarget {
  documentUri: string;
  selectionRange: Range;
}

export class VscodeSymbolTargetResolver {
  readonly #options: SymbolTargetResolverOptions;

  constructor(options: SymbolTargetResolverOptions) {
    this.#options = options;
  }

  async resolve(
    workspace: Workspace,
    params: { workspaceId: WorkspaceId; symbol: SymbolReference },
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<ResolvedSymbolTarget> {
    const handle = params.symbol.handle;
    if (handle !== undefined) {
      const resolved = this.#options.handles.resolve(handle, {
        adapterId: this.#options.adapterId,
        sessionId,
        workspaceId: workspace.workspaceId,
        workspaceEpoch: workspace.workspaceEpoch,
      });
      if (resolved !== undefined) {
        return {
          documentUri: resolved.documentUri,
          selectionRange: resolved.locator.selectionRange,
        };
      }
    }

    const locator = params.symbol.locator;
    if (locator === undefined) {
      // A handle that no longer resolves and no locator to relocate from: nothing identifies the
      // symbol any more, so the only truthful answer is that it is stale.
      throw adapterError("STALE_SYMBOL", { workspaceId: params.workspaceId });
    }
    if (!workspace.roots.some((root) => isUriWithinWorkspaceRoot(locator.documentUri, root.uri))) {
      throw adapterError("PERMISSION_DENIED");
    }

    const { drafts } = await this.documentSymbols(
      { workspaceId: params.workspaceId, uri: locator.documentUri },
      signal,
    );
    const outcome = relocateSymbol(locator, drafts);
    if (outcome.kind === "not-found") {
      throw adapterError("STALE_SYMBOL", { workspaceId: params.workspaceId });
    }
    if (outcome.kind === "ambiguous") {
      throw new BridgeAdapterRequestError({
        code: "AMBIGUOUS_SYMBOL",
        retryable: false,
        details: {
          workspaceId: params.workspaceId,
          documentUri: locator.documentUri,
          candidates: outcome.candidates,
        },
      });
    }
    return {
      documentUri: locator.documentUri,
      selectionRange: outcome.draft.locator.selectionRange,
    };
  }

  /** Runs the document symbol provider bracketed by exact revision captures (ADR-0016). */
  async documentSymbols(
    target: DocumentTargetParams,
    signal: AbortSignal,
  ): Promise<{ document: DocumentReference; drafts: SymbolDraft[] }> {
    const before = await this.#options.documentRoutes.read(target, signal);
    assertNotCancelled(signal);
    let providerResult: unknown;
    try {
      providerResult = await this.#options.provideDocumentSymbols(target.uri);
    } catch {
      assertNotCancelled(signal);
      throw adapterError("PROVIDER_FAILED");
    }
    assertNotCancelled(signal);

    const after = await this.#options.documentRoutes.read(target, signal);
    if (
      before.document.revision.editorVersion !== after.document.revision.editorVersion ||
      before.document.revision.contentHash !== after.document.revision.contentHash ||
      before.document.revision.workspaceEpoch !== after.document.revision.workspaceEpoch
    ) {
      throw new BridgeAdapterRequestError({
        code: "STALE_DOCUMENT",
        retryable: false,
        details: {
          workspaceId: before.document.workspaceId,
          documentUri: before.document.uri,
          currentRevision: after.document.revision,
        },
      });
    }

    let drafts;
    try {
      drafts = mapVscodeDocumentSymbols(providerResult, target.uri);
    } catch {
      throw adapterError("PROVIDER_FAILED");
    }
    if (drafts === undefined) {
      throw new BridgeAdapterRequestError({
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: "document/getSymbols" },
      });
    }
    return { document: before.document, drafts };
  }
}

export function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw adapterError("CANCELLED");
}

export function adapterError(
  code:
    | "CANCELLED"
    // An operation this adapter does not perform, told apart from one it attempted and failed.
    | "CAPABILITY_UNAVAILABLE"
    | "DOCUMENT_NOT_FOUND"
    | "INVALID_REQUEST"
    | "PERMISSION_DENIED"
    | "PRECONDITION_FAILED"
    | "PROVIDER_FAILED"
    | "STALE_SYMBOL",
  details?: { workspaceId?: string; documentUri?: string },
): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}
