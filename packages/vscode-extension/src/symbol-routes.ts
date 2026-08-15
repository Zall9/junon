import {
  BridgeAdapterRequestError,
  MAX_CLIENT_MESSAGE_BYTES,
  type ReconnectingBridgeConnection,
} from "@ide-bridge/bridge-client";
import {
  IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT,
  IDEBP_MAX_SYMBOL_SEARCH_LIMIT,
  isUriWithinWorkspaceRoot,
} from "@ide-bridge/protocol";
import type {
  AdapterId,
  JSONRPCRequestIdentifier,
  Revision,
  Symbol as IDEBPSymbol,
  SymbolKind,
  Workspace,
  WorkspaceId,
} from "@ide-bridge/protocol";

import type { VscodeDocumentRoutes } from "./document-routes.js";
import {
  VscodeSymbolHandleRegistry,
  mapVscodeDocumentSymbols,
  mapVscodeWorkspaceSymbols,
} from "./symbol-mapper.js";

export interface VscodeSymbolProviderHost {
  provideDocumentSymbols(uri: string): Promise<unknown>;
  provideWorkspaceSymbols(query: string): Promise<unknown>;
}

export interface VscodeSymbolRoutesOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  provider: VscodeSymbolProviderHost;
  currentWorkspace(): Workspace | undefined;
  handles?: VscodeSymbolHandleRegistry;
}

type AdapterRouteConnection = Pick<ReconnectingBridgeConnection, "onRequest">;

export class VscodeSymbolRoutes {
  readonly #options: VscodeSymbolRoutesOptions;
  readonly #handles: VscodeSymbolHandleRegistry;

  constructor(options: VscodeSymbolRoutesOptions) {
    this.#options = options;
    this.#handles = options.handles ?? new VscodeSymbolHandleRegistry();
  }

  attach(connection: AdapterRouteConnection): () => void {
    const disposers = [
      this.#attachDocumentSymbols(connection),
      this.#attachWorkspaceSearch(connection),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  #attachWorkspaceSearch(connection: AdapterRouteConnection): () => void {
    return connection.onRequest("workspace/searchSymbols", async (params, context) => {
      const workspace = this.#options.currentWorkspace();
      if (workspace === undefined || workspace.workspaceId !== params.workspaceId) {
        throw new BridgeAdapterRequestError({
          code: "WORKSPACE_NOT_FOUND",
          retryable: false,
          details: { workspaceId: params.workspaceId },
        });
      }
      assertNotCancelled(context.signal);

      let providerResult: unknown;
      try {
        providerResult = await this.#options.provider.provideWorkspaceSymbols(params.query);
      } catch {
        assertNotCancelled(context.signal);
        throw requestError("PROVIDER_FAILED");
      }
      assertNotCancelled(context.signal);

      // The workspace may have been reprojected while the provider ran. Handles are bound to the
      // epoch, so mint them only against the workspace that is current now.
      const current = this.#options.currentWorkspace();
      if (
        current === undefined ||
        current.workspaceId !== workspace.workspaceId ||
        current.workspaceEpoch !== workspace.workspaceEpoch
      ) {
        throw requestError("PROVIDER_FAILED");
      }

      const limit = Math.min(
        params.limit ?? IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT,
        IDEBP_MAX_SYMBOL_SEARCH_LIMIT,
      );
      const kinds = params.kinds === undefined ? undefined : new Set<SymbolKind>(params.kinds);
      let mapping;
      try {
        mapping = mapVscodeWorkspaceSymbols(providerResult, {
          isWithinWorkspace: (uri) =>
            current.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri)),
          ...(kinds === undefined ? {} : { kinds }),
          limit,
        });
      } catch {
        throw requestError("PROVIDER_FAILED");
      }
      if (mapping === undefined) {
        throw requestError("CAPABILITY_UNAVAILABLE", { capability: "workspace/searchSymbols" });
      }

      let symbols;
      try {
        symbols = this.#handles.materializeTransient(mapping.drafts, {
          adapterId: this.#options.adapterId,
          sessionId: context.sessionId,
          workspaceId: current.workspaceId,
          workspaceEpoch: current.workspaceEpoch,
        });
      } catch {
        throw requestError("PROVIDER_FAILED");
      }

      const fitted = fitSearchResult(context.id, symbols, mapping.incomplete);
      assertResponseFits(context.id, fitted);
      return fitted;
    });
  }

  #attachDocumentSymbols(connection: AdapterRouteConnection): () => void {
    return connection.onRequest("document/getSymbols", async (params, context) => {
      const content = await this.#options.documentRoutes.read(params, context.signal);
      assertNotCancelled(context.signal);
      let providerResult: unknown;
      try {
        providerResult = await this.#options.provider.provideDocumentSymbols(params.uri);
      } catch {
        assertNotCancelled(context.signal);
        throw requestError("PROVIDER_FAILED");
      }
      assertNotCancelled(context.signal);

      const current = await this.#options.documentRoutes.read(params, context.signal);
      if (!sameRevision(content.document.revision, current.document.revision)) {
        throw staleDocumentError(
          content.document.workspaceId,
          content.document.uri,
          current.document.revision,
        );
      }

      let drafts;
      try {
        drafts = mapVscodeDocumentSymbols(providerResult, params.uri);
      } catch {
        throw requestError("PROVIDER_FAILED");
      }
      if (drafts === undefined) {
        throw requestError("CAPABILITY_UNAVAILABLE", { capability: "document/getSymbols" });
      }

      let symbols;
      try {
        symbols = this.#handles.materialize(drafts, {
          adapterId: this.#options.adapterId,
          sessionId: context.sessionId,
          workspaceId: content.document.workspaceId,
          documentUri: content.document.uri,
          ...(content.document.revision.editorVersion === undefined
            ? {}
            : { editorVersion: content.document.revision.editorVersion }),
          workspaceEpoch: content.document.revision.workspaceEpoch,
        });
      } catch {
        throw requestError("PROVIDER_FAILED");
      }
      const result = { document: content.document, symbols };
      assertResponseFits(context.id, result);
      return result;
    });
  }

  invalidateDocument(workspaceId: WorkspaceId, uri: string): void {
    this.#handles.invalidateDocument(workspaceId, uri);
  }

  invalidateAll(): void {
    this.#handles.invalidateAll();
  }
}

function sameRevision(left: Revision, right: Revision): boolean {
  return (
    left.editorVersion === right.editorVersion &&
    left.contentHash === right.contentHash &&
    left.workspaceEpoch === right.workspaceEpoch
  );
}

function staleDocumentError(
  workspaceId: WorkspaceId,
  documentUri: string,
  currentRevision: Revision,
): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code: "STALE_DOCUMENT",
    retryable: false,
    details: { workspaceId, documentUri, currentRevision },
  });
}

function responseFits(id: JSONRPCRequestIdentifier, result: object): boolean {
  return (
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8") <=
    MAX_CLIENT_MESSAGE_BYTES
  );
}

function assertResponseFits(id: JSONRPCRequestIdentifier, result: object): void {
  if (!responseFits(id, result)) throw requestError("PROVIDER_FAILED");
}

/**
 * Shrinks an oversized search result instead of failing it. A search that matches many symbols is
 * a normal outcome, so the ceiling is reported through `truncated` rather than `PROVIDER_FAILED`.
 * Sizing always assumes `truncated: false`, the longer serialization, so the decision never
 * depends on the flag it produces.
 */
function fitSearchResult(
  id: JSONRPCRequestIdentifier,
  symbols: readonly IDEBPSymbol[],
  incomplete: boolean,
): { symbols: IDEBPSymbol[]; truncated: boolean } {
  let kept = [...symbols];
  let truncated = incomplete;
  while (kept.length > 0 && !responseFits(id, { symbols: kept, truncated: false })) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    truncated = true;
  }
  return { symbols: kept, truncated };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw requestError("CANCELLED");
}

function requestError(
  code: "CANCELLED" | "CAPABILITY_UNAVAILABLE" | "PROVIDER_FAILED",
  details?: { capability: string },
): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}
