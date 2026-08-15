import {
  BridgeAdapterRequestError,
  MAX_CLIENT_MESSAGE_BYTES,
  type ReconnectingBridgeConnection,
} from "@ide-bridge/bridge-client";
import { IDEBP_MAX_SYMBOL_LOCATIONS, isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
import type {
  AdapterId,
  DocumentTargetParams,
  JSONRPCRequestIdentifier,
  Position,
  Range,
  SessionId,
  SymbolLocation,
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
import { findSymbolAtPosition, relocateSymbol } from "./symbol-relocation.js";

export interface VscodeNavigationProviderHost {
  provideDocumentSymbols(uri: string): Promise<unknown>;
  provideDefinition(uri: string, position: Position): Promise<unknown>;
  provideReferences(uri: string, position: Position): Promise<unknown>;
  provideImplementations(uri: string, position: Position): Promise<unknown>;

  /**
   * One step of a hierarchy, in the relation named.
   *
   * VS Code's call and type hierarchies are two-phase: an item is prepared at a position, then
   * asked for its neighbours. The adapter hides that, because the protocol asks for one step and a
   * consumer should not have to know which of two APIs answers it.
   */
  provideHierarchy(
    uri: string,
    position: Position,
    relation: "callers" | "callees" | "supertypes" | "subtypes",
  ): Promise<unknown>;
}

export interface VscodeSymbolNavigationRoutesOptions {
  adapterId: AdapterId;
  documentRoutes: VscodeDocumentRoutes;
  provider: VscodeNavigationProviderHost;
  currentWorkspace(): Workspace | undefined;
  handles: VscodeSymbolHandleRegistry;
}

type AdapterRouteConnection = Pick<ReconnectingBridgeConnection, "onRequest">;

type LookupMethod =
  | "symbol/getDefinition"
  | "symbol/getReferences"
  | "symbol/getImplementations"
  | "symbol/getHierarchy";

type HierarchyRelation = "callers" | "callees" | "supertypes" | "subtypes";

/** Upper bound on provider entries examined, independent of how many survive root filtering. */
const MAX_LOCATION_SCAN = 20_000;

export class VscodeSymbolNavigationRoutes {
  readonly #options: VscodeSymbolNavigationRoutesOptions;

  constructor(options: VscodeSymbolNavigationRoutesOptions) {
    this.#options = options;
  }

  attach(connection: AdapterRouteConnection): () => void {
    const disposers = [
      this.#attachResolveAt(connection),
      this.#attachLookup(connection, "symbol/getDefinition", (uri, position) =>
        this.#options.provider.provideDefinition(uri, position),
      ),
      this.#attachLookup(connection, "symbol/getReferences", (uri, position) =>
        this.#options.provider.provideReferences(uri, position),
      ),
      this.#attachLookup(connection, "symbol/getImplementations", (uri, position) =>
        this.#options.provider.provideImplementations(uri, position),
      ),
      this.#attachHierarchy(connection),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  #attachResolveAt(connection: AdapterRouteConnection): () => void {
    return connection.onRequest("symbol/resolveAt", async (params, context) => {
      // The adapter registers utf-16 only. Reinterpreting another encoding would silently select
      // a different character, so a mismatch is refused rather than approximated.
      if (params.positionEncoding !== "utf-16") {
        throw requestError("INVALID_REQUEST");
      }
      const workspace = this.#assertWorkspace(params.workspaceId);
      const { document, drafts } = await this.#documentSymbols(
        { workspaceId: params.workspaceId, uri: params.uri },
        context.signal,
      );

      const draft = findSymbolAtPosition(drafts, params.position);
      if (draft === undefined) {
        // A blank line or a comment: an ordinary outcome, reported by omitting `symbol` rather
        // than by an error code that would misdescribe it (ADR-0018).
        const empty = { document };
        assertResponseFits(context.id, empty);
        return empty;
      }

      // Transient, not a document tree: a point resolution must not replace — and thereby revoke —
      // the handles a prior `document/getSymbols` handed out for this same document.
      const symbols = this.#options.handles.materializeTransient([{ ...draft, children: [] }], {
        adapterId: this.#options.adapterId,
        sessionId: context.sessionId,
        workspaceId: workspace.workspaceId,
        ...(document.revision.editorVersion === undefined
          ? {}
          : { editorVersion: document.revision.editorVersion }),
        workspaceEpoch: document.revision.workspaceEpoch,
      });
      const symbol = symbols[0];
      if (symbol === undefined) throw requestError("PROVIDER_FAILED");
      const result = { document, symbol };
      assertResponseFits(context.id, result);
      return result;
    });
  }

  /**
   * A hierarchy step, answered with the same shape as a lookup.
   *
   * Shares `#attachLookup`'s body deliberately: the response is `locations + truncated`, so it
   * inherits the same root filtering and the same daemon-side checks. A separate path would be a
   * second place for those to drift.
   */
  #attachHierarchy(connection: AdapterRouteConnection): () => void {
    return this.#attachLookup(
      connection,
      "symbol/getHierarchy",
      async (uri, position, relation) =>
        await this.#options.provider.provideHierarchy(
          uri,
          await this.#onIdentifier(uri, position),
          relation,
        ),
    );
  }

  /**
   * Moves a position onto the declaration's name, when it is not already there.
   *
   * A handle from `workspace/searchSymbols` carries the declaration's *start* — column 0 — because
   * that is what VS Code's workspace symbol provider reports. `prepareCallHierarchy` answers
   * nothing from there, so a consumer holding a search handle received an empty hierarchy and no
   * indication why: a silently empty answer, which is the failure this project refuses everywhere
   * else.
   *
   * The lookups do not need this — definition and reference providers accept the coarse position —
   * so the extra document-symbol query is spent only where it changes the answer.
   */
  async #onIdentifier(uri: string, position: Position): Promise<Position> {
    let drafts;
    try {
      ({ drafts } = await this.#documentSymbols(
        { workspaceId: this.#options.currentWorkspace()?.workspaceId as WorkspaceId, uri },
        new AbortController().signal,
      ));
    } catch {
      // The refinement is an improvement, not a precondition. If the document cannot be read the
      // original position is still the honest best guess.
      return position;
    }
    const draft = findSymbolAtPosition(drafts, position);
    return draft?.locator.selectionRange.start ?? position;
  }

  #attachLookup(
    connection: AdapterRouteConnection,
    method: LookupMethod,
    invoke: (uri: string, position: Position, relation: HierarchyRelation) => Promise<unknown>,
  ): () => void {
    return connection.onRequest(method, async (params, context) => {
      const workspace = this.#assertWorkspace(params.workspaceId);
      const target = await this.#resolveTarget(params, context.signal, context.sessionId);
      assertNotCancelled(context.signal);

      let providerResult: unknown;
      try {
        providerResult = await invoke(
          target.documentUri,
          target.selectionRange.start,
          // Only a hierarchy request carries one; the lookups ignore the argument.
          (params as { relation?: HierarchyRelation }).relation ?? "callers",
        );
      } catch {
        assertNotCancelled(context.signal);
        throw requestError("PROVIDER_FAILED");
      }
      assertNotCancelled(context.signal);
      if (providerResult === undefined || providerResult === null) {
        throw requestError("CAPABILITY_UNAVAILABLE", { capability: method });
      }

      let result: { locations: SymbolLocation[]; truncated: boolean };
      try {
        result = mapProviderLocations(providerResult, (uri) =>
          workspace.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri)),
        );
      } catch {
        throw requestError("PROVIDER_FAILED");
      }
      assertResponseFits(context.id, result);
      return result;
    });
  }

  /**
   * Resolves a consumer symbol reference to a concrete document position. A live handle is the
   * fast path; anything else goes through controlled relocation from the locator and fails closed.
   */
  async #resolveTarget(
    params: { workspaceId: WorkspaceId; symbol: SymbolReference },
    signal: AbortSignal,
    sessionId: SessionId,
  ): Promise<{ documentUri: string; selectionRange: Range }> {
    const workspace = this.#assertWorkspace(params.workspaceId);
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
      // A handle that no longer resolves and no locator to relocate from: there is nothing left
      // that identifies the symbol, so the only truthful answer is that it is stale.
      throw staleSymbolError(params.workspaceId);
    }
    if (!workspace.roots.some((root) => isUriWithinWorkspaceRoot(locator.documentUri, root.uri))) {
      throw requestError("PERMISSION_DENIED");
    }

    const { drafts } = await this.#documentSymbols(
      { workspaceId: params.workspaceId, uri: locator.documentUri },
      signal,
    );
    const outcome = relocateSymbol(locator, drafts);
    if (outcome.kind === "not-found") throw staleSymbolError(params.workspaceId);
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

  /** Runs the document symbol provider under the ADR-0016 revision bracket. */
  async #documentSymbols(
    target: DocumentTargetParams,
    signal: AbortSignal,
  ): Promise<{ document: SymbolResolveDocument; drafts: SymbolDraft[] }> {
    const before = await this.#options.documentRoutes.read(target, signal);
    assertNotCancelled(signal);
    let providerResult: unknown;
    try {
      providerResult = await this.#options.provider.provideDocumentSymbols(target.uri);
    } catch {
      assertNotCancelled(signal);
      throw requestError("PROVIDER_FAILED");
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
      throw requestError("PROVIDER_FAILED");
    }
    if (drafts === undefined) {
      throw requestError("CAPABILITY_UNAVAILABLE", { capability: "document/getSymbols" });
    }
    return { document: before.document, drafts };
  }

  #assertWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined || workspace.workspaceId !== workspaceId) {
      throw new BridgeAdapterRequestError({
        code: "WORKSPACE_NOT_FOUND",
        retryable: false,
        details: { workspaceId },
      });
    }
    return workspace;
  }
}

type SymbolResolveDocument = Awaited<ReturnType<VscodeDocumentRoutes["read"]>>["document"];

/**
 * Maps `Location[]` or `LocationLink[]` provider output.
 *
 * Locations outside every registered root are filtered, and that filtering does **not** set
 * `truncated`: it is a scope decision, and the daemon enforces the same containment. `truncated`
 * reports only the fixed ceiling, so a consumer can tell a complete answer from a capped one
 * (ADR-0018). The ceiling is applied after filtering, so out-of-scope entries never displace
 * in-scope ones.
 */
export function mapProviderLocations(
  value: unknown,
  isWithinWorkspace: (uri: string) => boolean,
): { locations: SymbolLocation[]; truncated: boolean } {
  if (!Array.isArray(value)) throw new Error("Location provider returned a non-array");
  const locations: SymbolLocation[] = [];
  let truncated = false;
  const entries = value as unknown[];
  // Filtering happens per entry, so a provider returning mostly out-of-scope results must not be
  // able to make this loop unbounded.
  const scanned = Math.min(entries.length, MAX_LOCATION_SCAN);
  if (entries.length > scanned) truncated = true;
  for (let index = 0; index < scanned; index += 1) {
    const entry = entries[index];
    const mapped = mapProviderLocation(entry);
    if (mapped === undefined) throw new Error("Location provider returned an unmappable entry");
    if (!isWithinWorkspace(mapped.location.uri)) continue;
    if (locations.length >= IDEBP_MAX_SYMBOL_LOCATIONS) {
      truncated = true;
      break;
    }
    locations.push(mapped);
  }
  return { locations, truncated };
}

function mapProviderLocation(value: unknown): SymbolLocation | undefined {
  if (!isRecord(value)) return undefined;
  const direct = readUri(value["uri"]);
  if (direct !== undefined) {
    const range = readRange(value["range"]);
    return range === undefined
      ? undefined
      : { location: { uri: direct, range, positionEncoding: "utf-16" } };
  }
  const targetUri = readUri(value["targetUri"]);
  if (targetUri === undefined) return undefined;
  // LocationLink: the selection range is the identifier span when the provider supplies it.
  const range = readRange(value["targetSelectionRange"]) ?? readRange(value["targetRange"]);
  return range === undefined
    ? undefined
    : { location: { uri: targetUri, range, positionEncoding: "utf-16" } };
}

function readUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["toString"] !== "function") return undefined;
  let uri: unknown;
  try {
    uri = (value as { toString(): unknown }).toString();
  } catch {
    return undefined;
  }
  return typeof uri === "string" && uri.length > 0 ? uri : undefined;
}

function readRange(value: unknown): Range | undefined {
  if (!isRecord(value)) return undefined;
  const start = readPosition(value["start"]);
  const end = readPosition(value["end"]);
  if (start === undefined || end === undefined) return undefined;
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
    return undefined;
  }
  return { start, end };
}

function readPosition(value: unknown): Position | undefined {
  if (!isRecord(value)) return undefined;
  const line = value["line"];
  const character = value["character"];
  if (!Number.isSafeInteger(line) || Number(line) < 0) return undefined;
  if (!Number.isSafeInteger(character) || Number(character) < 0) return undefined;
  return { line: Number(line), character: Number(character) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertResponseFits(id: JSONRPCRequestIdentifier, result: object): void {
  if (
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8") >
    MAX_CLIENT_MESSAGE_BYTES
  ) {
    throw requestError("PROVIDER_FAILED");
  }
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw requestError("CANCELLED");
}

function staleSymbolError(workspaceId: string): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code: "STALE_SYMBOL",
    retryable: false,
    details: { workspaceId },
  });
}

function requestError(
  code:
    | "CANCELLED"
    | "CAPABILITY_UNAVAILABLE"
    | "INVALID_REQUEST"
    | "PERMISSION_DENIED"
    | "PROVIDER_FAILED",
  details?: { capability: string },
): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({
    code,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}
