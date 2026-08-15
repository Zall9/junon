import {
  BridgeAdapterRequestError,
  MAX_CLIENT_MESSAGE_BYTES,
  type ReconnectingBridgeConnection,
} from "@ide-bridge/bridge-client";
import type {
  DocumentContent,
  DocumentTargetParams,
  JSONRPCRequestIdentifier,
  Workspace,
} from "@ide-bridge/protocol";

import {
  mapDiskDocumentAsync,
  mapTextDocumentAsync,
  type VscodeDocumentUriLike,
  type VscodeTextDocumentLike,
} from "./document-mapper.js";
import type { VscodeWorkspaceFolderLike, VscodeWorkspaceModel } from "./workspace-model.js";

export interface VscodeDocumentHost {
  parseUri(value: string): VscodeDocumentUriLike;
  getWorkspaceFolder(uri: VscodeDocumentUriLike): VscodeWorkspaceFolderLike | undefined;
  openTextDocument(uri: VscodeDocumentUriLike): Promise<VscodeTextDocumentLike>;
  /** Reads file content without creating a `TextDocument`, so no open/close event is emitted. */
  readFile?(uri: VscodeDocumentUriLike): Promise<string>;
}

export interface VscodeDocumentRoutesOptions {
  host: VscodeDocumentHost;
  workspaceModel: VscodeWorkspaceModel;
  currentWorkspace(): Workspace | undefined;
}

type AdapterRouteConnection = Pick<ReconnectingBridgeConnection, "onRequest">;

export class VscodeDocumentRoutes {
  readonly #options: VscodeDocumentRoutesOptions;

  constructor(options: VscodeDocumentRoutesOptions) {
    this.#options = options;
  }

  attach(connection: AdapterRouteConnection): () => void {
    const disposers = [
      connection.onRequest("document/read", async (params, context) => {
        const content = await this.read(params, context.signal);
        assertResponseFits(context.id, content);
        return content;
      }),
      connection.onRequest("document/getRevision", async (params, context) => {
        const content = await this.read(params, context.signal);
        const result = { document: content.document };
        assertResponseFits(context.id, result);
        return result;
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  async read(params: DocumentTargetParams, signal?: AbortSignal): Promise<DocumentContent> {
    assertNotCancelled(signal);
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined || workspace.workspaceId !== params.workspaceId) {
      throw requestError("WORKSPACE_NOT_FOUND", {
        workspaceId: params.workspaceId,
      });
    }

    let uri: VscodeDocumentUriLike;
    try {
      uri = this.#options.host.parseUri(params.uri);
    } catch {
      throw documentNotFound(params);
    }
    if (uri.toString() !== params.uri) throw documentNotFound(params);

    const folder = this.#options.host.getWorkspaceFolder(uri);
    if (folder === undefined) throw documentNotFound(params);
    const root = this.#options.workspaceModel.rootFor(folder);
    if (
      root === undefined ||
      !workspace.roots.some((candidate) => candidate.rootId === root.rootId)
    ) {
      throw documentNotFound(params);
    }

    let document: VscodeTextDocumentLike;
    try {
      document = await this.#options.host.openTextDocument(uri);
    } catch {
      throw documentNotFound(params);
    }
    assertNotCancelled(signal);
    if (document.uri.toString() !== params.uri) throw documentNotFound(params);

    try {
      const content = await mapTextDocumentAsync(document, {
        workspace,
        root,
        rootUri: folder.uri as VscodeDocumentUriLike,
      });
      assertNotCancelled(signal);
      return content;
    } catch (error) {
      if (error instanceof BridgeAdapterRequestError) throw error;
      throw requestError("PROVIDER_FAILED");
    }
  }

  /**
   * Reads a document's content from disk without opening an editor buffer. The resulting revision
   * carries no `editorVersion` (ADR-0020). Returns `undefined` when the URI is not a readable file
   * inside a registered root.
   */
  async readFromDisk(uri: string, signal?: AbortSignal): Promise<DocumentContent | undefined> {
    assertNotCancelled(signal);
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined) return undefined;

    let parsed: VscodeDocumentUriLike;
    try {
      parsed = this.#options.host.parseUri(uri);
    } catch {
      return undefined;
    }
    if (parsed.toString() !== uri) return undefined;
    const folder = this.#options.host.getWorkspaceFolder(parsed);
    if (folder === undefined) return undefined;
    const root = this.#options.workspaceModel.rootFor(folder);
    if (
      root === undefined ||
      !workspace.roots.some((candidate) => candidate.rootId === root.rootId)
    ) {
      return undefined;
    }

    let text: string | undefined;
    try {
      text = await this.#options.host.readFile?.(parsed);
    } catch {
      return undefined;
    }
    if (text === undefined) return undefined;
    assertNotCancelled(signal);
    try {
      return await mapDiskDocumentAsync(parsed, text, {
        workspace,
        root,
        rootUri: folder.uri as VscodeDocumentUriLike,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * The document as the protocol describes it, or why it cannot be described.
   *
   * This returned `undefined` for four different situations, and the event bridge dropped the
   * notification without a word for each of them. That silence was a plausible enough explanation
   * for a lost `document/changed` that it was believed for a day — wrongly, as it turned out
   * (ADR-0037). The four reasons are named anyway: the next lost notification should not need a
   * three-day investigation to rule this out, and ruling it out is now one log line.
   *
   * The reasons are a closed set of names carrying no content, so they can be logged under the same
   * rule as every other event this extension records.
   */
  async mapOpenDocument(document: VscodeTextDocumentLike): Promise<MapDocumentOutcome> {
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined) return { skipped: "no-workspace" };
    // A buffer the editor invents — its chat input, an output channel, a settings editor — is not a
    // workspace document that went missing; it was never one. Measured: every run drops
    // `chatSessionInput:input-0`, and folding that into `outside-workspace` would mean a real file
    // falling outside the registered roots is reported in the same words as routine editor noise.
    if (!workspace.roots.some((root) => root.uri.startsWith(`${document.uri.scheme}:`))) {
      return { skipped: "unsupported-scheme" };
    }
    const folder = this.#options.host.getWorkspaceFolder(document.uri);
    if (folder === undefined) return { skipped: "outside-workspace" };
    const root = this.#options.workspaceModel.rootFor(folder);
    if (
      root === undefined ||
      !workspace.roots.some((candidate) => candidate.rootId === root.rootId)
    ) {
      return { skipped: "no-matching-root" };
    }
    try {
      return {
        content: await mapTextDocumentAsync(document, {
          workspace,
          root,
          rootUri: folder.uri as VscodeDocumentUriLike,
        }),
      };
    } catch {
      return { skipped: "unmappable" };
    }
  }
}

/** Why a document could not be described, or the description. */
export type MapDocumentOutcome =
  | { readonly content: DocumentContent; readonly skipped?: undefined }
  | { readonly content?: undefined; readonly skipped: MapDocumentSkip };

export type MapDocumentSkip =
  "no-matching-root" | "no-workspace" | "outside-workspace" | "unmappable" | "unsupported-scheme";

function assertResponseFits(id: JSONRPCRequestIdentifier, result: object): void {
  const encodedBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8");
  if (encodedBytes > MAX_CLIENT_MESSAGE_BYTES) {
    throw requestError("PROVIDER_FAILED");
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw requestError("CANCELLED");
}

function documentNotFound(params: DocumentTargetParams): BridgeAdapterRequestError {
  return requestError("DOCUMENT_NOT_FOUND", {
    workspaceId: params.workspaceId,
    documentUri: params.uri,
  });
}

function requestError(
  code: "CANCELLED" | "DOCUMENT_NOT_FOUND" | "PROVIDER_FAILED" | "WORKSPACE_NOT_FOUND",
  details?: { workspaceId?: string; documentUri?: string },
): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}
