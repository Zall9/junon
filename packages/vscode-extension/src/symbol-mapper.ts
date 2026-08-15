import { createHash, randomBytes } from "node:crypto";

import type {
  AdapterId,
  Range,
  SessionId,
  Symbol as IDEBPSymbol,
  SymbolHandle,
  SymbolHandleId,
  SymbolKind,
  SymbolLocator,
  WorkspaceId,
} from "@ide-bridge/protocol";

const MAX_DOCUMENT_SYMBOLS = 5_000;
const MAX_SYMBOL_DEPTH = 64;
const MAX_SYMBOL_TEXT_LENGTH = 1_024;
const DEFAULT_MAX_HANDLES = 20_000;
const MAX_SEARCH_SCAN = 20_000;
const MAX_TRANSIENT_GENERATIONS = 5;

/**
 * Positional: VS Code reports a symbol kind as an index into this list, so the order is the
 * provider's, not ours. `unknown` is deliberately absent — VS Code always supplies a kind, and
 * appending it here would shift nothing but would suggest a 27th index the API never sends.
 */
const SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
] as const satisfies readonly SymbolKind[];

export interface VscodePositionLike {
  readonly line: number;
  readonly character: number;
}

export interface VscodeRangeLike {
  readonly start: VscodePositionLike;
  readonly end: VscodePositionLike;
}

export interface VscodeDocumentSymbolLike {
  readonly name: string;
  readonly kind: number;
  readonly range: VscodeRangeLike;
  readonly selectionRange: VscodeRangeLike;
  readonly children: readonly VscodeDocumentSymbolLike[];
}

export interface VscodeSymbolInformationLike {
  readonly name: string;
  readonly kind: number;
  readonly containerName: string;
  readonly location: {
    readonly uri: { toString(): string };
    readonly range: VscodeRangeLike;
  };
}

export type VscodeDocumentSymbolResult =
  readonly VscodeDocumentSymbolLike[] | readonly VscodeSymbolInformationLike[];

export interface SymbolDraft {
  locator: SymbolLocator;
  range: Range;
  children: SymbolDraft[];
}

interface HandleRecord {
  /**
   * `document` handles are the whole symbol tree of one document and are replaced atomically when
   * that tree is recomputed. `transient` handles are individual results — a search hit or a
   * point resolution — and live in bounded FIFO generations so that producing one never revokes
   * handles a document already handed out.
   */
  kind: "document" | "transient";
  workspaceId: WorkspaceId;
  documentUri: string;
  /**
   * Present only when the handle was minted against a bracketed revision. Search handles have
   * none (ADR-0017): the provider ran over its own snapshots of many documents, so any revision
   * captured afterwards would prove nothing.
   */
  editorVersion?: number;
  locator: SymbolLocator;
}

export interface MaterializeSymbolContext {
  adapterId: AdapterId;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  documentUri: string;
  /** Absent when the symbols were computed over on-disk content (ADR-0020). */
  editorVersion?: number;
  workspaceEpoch: number;
}

export interface ResolveHandleContext {
  adapterId: AdapterId;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  workspaceEpoch: number;
}

export interface MaterializeTransientContext extends ResolveHandleContext {
  /** Supplied only when the caller bracketed a revision, as `symbol/resolveAt` does. */
  editorVersion?: number;
}

export interface ResolvedHandle {
  kind: "document" | "transient";
  documentUri: string;
  /** Absent when the handle was minted without a bracketed revision (ADR-0017). */
  editorVersion?: number;
  locator: SymbolLocator;
}

export class VscodeSymbolHandleRegistry {
  readonly #maxHandles: number;
  readonly #records = new Map<SymbolHandleId, HandleRecord>();
  readonly #documentHandles = new Map<string, Set<SymbolHandleId>>();
  /** Individual results are retained as bounded FIFO generations, evicted oldest first. */
  readonly #transientGenerations: Set<SymbolHandleId>[] = [];
  readonly #transientByDocument = new Map<string, Set<SymbolHandleId>>();

  constructor(maxHandles = DEFAULT_MAX_HANDLES) {
    if (!Number.isSafeInteger(maxHandles) || maxHandles < 1) {
      throw new Error("Symbol handle capacity must be a positive safe integer");
    }
    this.#maxHandles = maxHandles;
  }

  /** Number of live handles across both namespaces. Bounded by the configured capacity. */
  get size(): number {
    return this.#records.size;
  }

  /**
   * Resolves a consumer-supplied handle to its record. Returns `undefined` for any handle this
   * adapter did not mint in this physical session and epoch, or that has since been invalidated —
   * the caller then falls back to controlled locator relocation rather than guessing.
   */
  resolve(handle: SymbolHandle, context: ResolveHandleContext): ResolvedHandle | undefined {
    if (
      handle.adapterId !== context.adapterId ||
      handle.sessionId !== context.sessionId ||
      handle.validUntilEpoch !== context.workspaceEpoch
    ) {
      return undefined;
    }
    const record = this.#records.get(handle.id);
    if (record === undefined || record.workspaceId !== context.workspaceId) return undefined;
    return {
      kind: record.kind,
      documentUri: record.documentUri,
      ...(record.editorVersion === undefined ? {} : { editorVersion: record.editorVersion }),
      locator: structuredClone(record.locator),
    };
  }

  materialize(drafts: readonly SymbolDraft[], context: MaterializeSymbolContext): IDEBPSymbol[] {
    const count = countDrafts(drafts);
    const documentKey = key(context.workspaceId, context.documentUri);
    const replacedCount = this.#documentHandles.get(documentKey)?.size ?? 0;
    this.#reserveCapacity(count - replacedCount);

    const staged = new Map<SymbolHandleId, HandleRecord>();
    const symbols = drafts.map((draft) =>
      this.#materializeDraft(draft, context, staged, (locator) => ({
        kind: "document",
        workspaceId: context.workspaceId,
        documentUri: context.documentUri,
        ...(context.editorVersion === undefined ? {} : { editorVersion: context.editorVersion }),
        locator,
      })),
    );
    this.invalidateDocument(context.workspaceId, context.documentUri);
    const ids = new Set<SymbolHandleId>();
    for (const [id, record] of staged) {
      this.#records.set(id, record);
      ids.add(id);
    }
    this.#documentHandles.set(documentKey, ids);
    return symbols;
  }

  /**
   * Materializes individual results — search hits or a point resolution — as their own generation.
   * These never replace a document's handles: producing one for a document already explored
   * through `document/getSymbols` must not invalidate the handles that document handed out.
   */
  materializeTransient(
    drafts: readonly SymbolDraft[],
    context: MaterializeTransientContext,
  ): IDEBPSymbol[] {
    this.#reserveCapacity(drafts.length);
    const staged = new Map<SymbolHandleId, HandleRecord>();
    const symbols = drafts.map((draft) =>
      this.#materializeDraft(
        { ...draft, children: [] },
        { ...context, documentUri: draft.locator.documentUri },
        staged,
        (locator) => ({
          kind: "transient",
          workspaceId: context.workspaceId,
          documentUri: locator.documentUri,
          ...(context.editorVersion === undefined ? {} : { editorVersion: context.editorVersion }),
          locator,
        }),
      ),
    );

    const generation = new Set<SymbolHandleId>();
    for (const [id, record] of staged) {
      this.#records.set(id, record);
      generation.add(id);
      const documentKey = key(record.workspaceId, record.documentUri);
      let byDocument = this.#transientByDocument.get(documentKey);
      if (byDocument === undefined) {
        byDocument = new Set<SymbolHandleId>();
        this.#transientByDocument.set(documentKey, byDocument);
      }
      byDocument.add(id);
    }
    this.#transientGenerations.push(generation);
    while (this.#transientGenerations.length > MAX_TRANSIENT_GENERATIONS)
      this.#evictOldestTransient();
    return symbols;
  }

  invalidateDocument(workspaceId: WorkspaceId, documentUri: string): void {
    const documentKey = key(workspaceId, documentUri);
    const ids = this.#documentHandles.get(documentKey);
    if (ids !== undefined) {
      for (const id of ids) this.#records.delete(id);
      this.#documentHandles.delete(documentKey);
    }
    const transientIds = this.#transientByDocument.get(documentKey);
    if (transientIds === undefined) return;
    for (const id of transientIds) {
      this.#records.delete(id);
      for (const generation of this.#transientGenerations) generation.delete(id);
    }
    this.#transientByDocument.delete(documentKey);
  }

  invalidateAll(): void {
    this.#records.clear();
    this.#documentHandles.clear();
    this.#transientGenerations.length = 0;
    this.#transientByDocument.clear();
  }

  /**
   * Makes room for `additional` handles. Search generations are evicted oldest first so that a
   * long-lived registry never fails a request because of accumulated search history, and never
   * sacrifices a document's handles to do so.
   */
  #reserveCapacity(additional: number): void {
    while (
      this.#records.size + additional > this.#maxHandles &&
      this.#transientGenerations.length > 0
    ) {
      this.#evictOldestTransient();
    }
    if (this.#records.size + additional > this.#maxHandles) {
      throw new Error("Symbol handle capacity exceeded");
    }
  }

  #evictOldestTransient(): void {
    const oldest = this.#transientGenerations.shift();
    if (oldest === undefined) return;
    for (const id of oldest) {
      const record = this.#records.get(id);
      this.#records.delete(id);
      if (record === undefined) continue;
      const documentKey = key(record.workspaceId, record.documentUri);
      const byDocument = this.#transientByDocument.get(documentKey);
      if (byDocument === undefined) continue;
      byDocument.delete(id);
      if (byDocument.size === 0) this.#transientByDocument.delete(documentKey);
    }
  }

  #materializeDraft(
    draft: SymbolDraft,
    context: MaterializeTransientContext & { documentUri: string },
    staged: Map<SymbolHandleId, HandleRecord>,
    createRecord: (locator: SymbolLocator) => HandleRecord,
  ): IDEBPSymbol {
    const id = this.#createHandleId(staged);
    staged.set(id, createRecord(structuredClone(draft.locator)));
    return {
      handle: {
        adapterId: context.adapterId,
        sessionId: context.sessionId,
        id,
        validUntilEpoch: context.workspaceEpoch,
      },
      locator: structuredClone(draft.locator),
      range: structuredClone(draft.range),
      children: draft.children.map((child) =>
        this.#materializeDraft(child, context, staged, createRecord),
      ),
    };
  }

  #createHandleId(staged: ReadonlyMap<SymbolHandleId, HandleRecord>): SymbolHandleId {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id: SymbolHandleId = `sym_${randomBytes(18).toString("base64url")}`;
      if (!this.#records.has(id) && !staged.has(id)) return id;
    }
    throw new Error("Could not allocate a unique symbol handle");
  }
}

export interface WorkspaceSearchMappingOptions {
  /** Root containment predicate, evaluated with the exact provider-supplied URI. */
  isWithinWorkspace(documentUri: string): boolean;
  /** Optional caller-requested kind filter. */
  kinds?: ReadonlySet<SymbolKind>;
  /** Effective result ceiling. */
  limit: number;
}

export interface WorkspaceSearchMapping {
  drafts: SymbolDraft[];
  /**
   * True when the workspace holds matches this result does not carry: entries capped by the
   * limit, entries beyond the scan bound, and in-scope entries the provider returned in a form
   * IDEBP cannot represent (notably a partial `location` without a `range`, which the
   * `WorkspaceSymbolProvider` contract explicitly permits). Entries dropped because they fall
   * outside a registered root or fail the requested kind filter are not counted: those are
   * scope decisions, not missing results.
   */
  incomplete: boolean;
}

/**
 * Maps a workspace symbol search result. Unlike document symbols, hits span many documents and
 * arrive flat, so foreign URIs are filtered rather than rejected and no entry carries children.
 */
export function mapVscodeWorkspaceSymbols(
  value: unknown,
  options: WorkspaceSearchMappingOptions,
): WorkspaceSearchMapping | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Workspace symbol provider returned a non-array");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error("Workspace symbol search limit must be a positive safe integer");
  }

  const drafts: SymbolDraft[] = [];
  let incomplete = false;
  const scanned = Math.min(value.length, MAX_SEARCH_SCAN);
  if (value.length > scanned) incomplete = true;

  for (let index = 0; index < scanned; index += 1) {
    if (drafts.length >= options.limit) {
      incomplete = true;
      break;
    }
    const entry: unknown = value[index];
    const documentUri = workspaceSymbolUri(entry);
    if (documentUri === undefined) {
      // No attributable URI: the entry cannot be scoped, so it is reported as missing rather
      // than silently discarded as out of scope.
      incomplete = true;
      continue;
    }
    if (!options.isWithinWorkspace(documentUri)) continue;
    let draft: SymbolDraft;
    try {
      draft = mapWorkspaceSymbol(entry, documentUri);
    } catch {
      incomplete = true;
      continue;
    }
    if (options.kinds !== undefined && !options.kinds.has(draft.locator.kind)) continue;
    drafts.push(draft);
  }
  return { drafts, incomplete };
}

function workspaceSymbolUri(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const location = value["location"];
  if (!isRecord(location)) return undefined;
  const uri = location["uri"];
  if (!isRecord(uri) || typeof uri["toString"] !== "function") return undefined;
  let documentUri: unknown;
  try {
    documentUri = (uri as { toString(): unknown }).toString();
  } catch {
    return undefined;
  }
  if (typeof documentUri !== "string" || documentUri.length === 0) return undefined;
  return documentUri;
}

/**
 * `SymbolInformation` carries a single range. It is used for both the declaration range and the
 * locator selection range: the provider supplies no narrower identifier range for search hits,
 * and inventing one would misrepresent the provider's output.
 */
function mapWorkspaceSymbol(value: unknown, documentUri: string): SymbolDraft {
  if (!isWorkspaceSymbolInformation(value)) {
    throw new Error("Workspace symbol provider returned an unmappable entry");
  }
  const name = symbolText(value.name);
  const kind = symbolKind(value.kind);
  const range = mapRange(value.location.range);
  const containerName =
    typeof value.containerName === "string" ? optionalSymbolText(value.containerName) : undefined;
  return {
    locator: createLocator(documentUri, name, kind, range, containerName),
    range,
    children: [],
  };
}

/**
 * Same shape as a document `SymbolInformation` except that `containerName` may be absent: search
 * providers commonly omit it. A `location` without a `range` fails here on purpose — the provider
 * contract allows it, but IDEBP requires a range and none can be resolved from an extension.
 */
function isWorkspaceSymbolInformation(
  value: unknown,
): value is Omit<VscodeSymbolInformationLike, "containerName"> & { containerName?: string } {
  if (!isRecord(value) || typeof value["name"] !== "string" || typeof value["kind"] !== "number") {
    return false;
  }
  if (value["containerName"] !== undefined && typeof value["containerName"] !== "string") {
    return false;
  }
  const location = value["location"];
  return isRecord(location) && isRange(location["range"]);
}

export function mapVscodeDocumentSymbols(
  value: unknown,
  documentUri: string,
): SymbolDraft[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Document symbol provider returned a non-array");
  if (value.length > MAX_DOCUMENT_SYMBOLS) {
    throw new Error("Document symbol result exceeds structural bounds");
  }
  if (value.length === 0) return [];

  const state = { count: 0, seen: new WeakSet<object>() };
  if (value.every(isDocumentSymbol)) {
    return value.map((symbol) => mapDocumentSymbol(symbol, documentUri, undefined, 0, state));
  }
  if (value.every(isSymbolInformation)) {
    return value.map((symbol) => mapSymbolInformation(symbol, documentUri, state));
  }
  throw new Error("Document symbol provider returned mixed or malformed symbols");
}

function mapDocumentSymbol(
  symbol: VscodeDocumentSymbolLike,
  documentUri: string,
  containerName: string | undefined,
  depth: number,
  state: { count: number; seen: WeakSet<object> },
): SymbolDraft {
  enterSymbol(symbol, depth, state);
  const name = symbolText(symbol.name);
  const kind = symbolKind(symbol.kind);
  const range = mapRange(symbol.range);
  const selectionRange = mapRange(symbol.selectionRange);
  if (!containsRange(range, selectionRange)) {
    throw new Error("Document symbol selection range is outside its declaration range");
  }
  const locator = createLocator(documentUri, name, kind, selectionRange, containerName);
  return {
    locator,
    range,
    children: symbol.children.map((child) =>
      mapDocumentSymbol(child, documentUri, name, depth + 1, state),
    ),
  };
}

function mapSymbolInformation(
  symbol: VscodeSymbolInformationLike,
  documentUri: string,
  state: { count: number; seen: WeakSet<object> },
): SymbolDraft {
  enterSymbol(symbol, 0, state);
  if (symbol.location.uri.toString() !== documentUri) {
    throw new Error("Document symbol provider returned a foreign URI");
  }
  const name = symbolText(symbol.name);
  const kind = symbolKind(symbol.kind);
  const range = mapRange(symbol.location.range);
  const containerName = optionalSymbolText(symbol.containerName);
  return {
    locator: createLocator(documentUri, name, kind, range, containerName),
    range,
    children: [],
  };
}

function createLocator(
  documentUri: string,
  name: string,
  kind: SymbolKind,
  selectionRange: Range,
  containerName: string | undefined,
): SymbolLocator {
  const identity = JSON.stringify([
    documentUri,
    name,
    kind,
    containerName ?? "",
    selectionRange.start.line,
    selectionRange.start.character,
    selectionRange.end.line,
    selectionRange.end.character,
  ]);
  return {
    documentUri,
    name,
    kind,
    ...(containerName === undefined ? {} : { containerName }),
    selectionRange,
    positionEncoding: "utf-16",
    fingerprint: `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`,
  };
}

function enterSymbol(
  symbol: object,
  depth: number,
  state: { count: number; seen: WeakSet<object> },
): void {
  if (depth > MAX_SYMBOL_DEPTH || state.count >= MAX_DOCUMENT_SYMBOLS || state.seen.has(symbol)) {
    throw new Error("Document symbol result exceeds structural bounds");
  }
  state.seen.add(symbol);
  state.count += 1;
}

function isDocumentSymbol(value: unknown): value is VscodeDocumentSymbolLike {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["kind"] === "number" &&
    isRange(value["range"]) &&
    isRange(value["selectionRange"]) &&
    Array.isArray(value["children"])
  );
}

function isSymbolInformation(value: unknown): value is VscodeSymbolInformationLike {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["kind"] !== "number" ||
    typeof value["containerName"] !== "string"
  ) {
    return false;
  }
  const location = value["location"];
  return (
    isRecord(location) &&
    isRecord(location["uri"]) &&
    typeof location["uri"]["toString"] === "function" &&
    isRange(location["range"])
  );
}

function isRange(value: unknown): value is VscodeRangeLike {
  return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}

function isPosition(value: unknown): value is VscodePositionLike {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value["line"]) &&
    Number(value["line"]) >= 0 &&
    Number.isSafeInteger(value["character"]) &&
    Number(value["character"]) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRange(range: VscodeRangeLike): Range {
  if (!isRange(range) || comparePosition(range.start, range.end) > 0) {
    throw new Error("Document symbol range is invalid");
  }
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function containsRange(outer: Range, inner: Range): boolean {
  return (
    comparePosition(outer.start, inner.start) <= 0 && comparePosition(inner.end, outer.end) <= 0
  );
}

function comparePosition(left: VscodePositionLike, right: VscodePositionLike): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

function symbolKind(kind: number): SymbolKind {
  if (!Number.isSafeInteger(kind) || kind < 0 || kind >= SYMBOL_KINDS.length) {
    throw new Error("Document symbol kind is unsupported");
  }
  const mapped = SYMBOL_KINDS[kind];
  if (mapped === undefined) throw new Error("Document symbol kind is unsupported");
  return mapped;
}

function symbolText(value: string): string {
  if (value.trim().length === 0 || value.length > MAX_SYMBOL_TEXT_LENGTH) {
    throw new Error("Document symbol text is invalid");
  }
  return value;
}

function optionalSymbolText(value: string): string | undefined {
  return value.length === 0 ? undefined : symbolText(value);
}

function countDrafts(drafts: readonly SymbolDraft[]): number {
  let count = 0;
  const stack = [...drafts];
  while (stack.length > 0) {
    const draft = stack.pop();
    if (draft === undefined) continue;
    count += 1;
    stack.push(...draft.children);
  }
  return count;
}

function key(workspaceId: WorkspaceId, documentUri: string): string {
  return `${workspaceId}\u0000${documentUri}`;
}
