import { randomBytes } from "node:crypto";

import {
  IDEBP_ADAPTER_ORIGINATED_METHODS,
  IDEBP_CONSUMER_LOCAL_METHODS,
  IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT,
  IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT,
  IDEBP_MAX_DIAGNOSTIC_DOCUMENTS,
  IDEBP_MAX_SYMBOL_LOCATIONS,
  IDEBP_MAX_SYMBOL_SEARCH_LIMIT,
  IDEBP_ROUTED_METHODS,
  PROTOCOL_VERSION,
  classifyIDEBPNotification,
  isIDEBPApplicationMethod,
  isIDEBPApplicationRequest,
  isIDEBPApplicationResponse,
  describeApplicationResponseFailure,
  isIDEBPJSONRPCErrorResponse,
  isJSONRPCRequestIdentifier,
} from "@ide-bridge/protocol";
import type {
  AdapterId,
  IDEBPApplicationMethod,
  IDEBPApplicationRequestByMethod,
  IDEBPJSONRPCErrorResponse,
  IDEBPNotificationMethod,
  IDEBPNotificationParams,
  IDEBPResponseResult,
  JSONRPCRequestIdentifier,
  ModifiedDocument,
  ModificationResult,
  DocumentDiagnostics,
  SessionId,
  Symbol as IDEBPSymbol,
  SymbolLocation,
  WorkspaceId,
} from "@ide-bridge/protocol";

import { DAEMON_VERSION } from "../metadata.js";
import {
  EditStoreError,
  InMemoryEditStore,
  type StalePlanReason,
  type StoredPlan,
  type StoredUndoToken,
} from "../plan/in-memory-edit-store.js";
import { MetricsRegistry } from "../observability/metrics-registry.js";
import type { MetricsSnapshot } from "../observability/metrics-registry.js";
import { isUriWithinWorkspaceRoot } from "../security/workspace-uri.js";
import {
  SessionRegistry,
  SessionRegistryError,
  type RegistryErrorCode,
} from "../session/session-registry.js";
import type {
  AuthenticatedTransportConnection,
  SessionCloseReason,
} from "../transport/transport.js";

const ADAPTER_REQUEST_METHODS = new Set<IDEBPApplicationMethod>(IDEBP_ADAPTER_ORIGINATED_METHODS);
const CONSUMER_LOCAL_METHODS = new Set<IDEBPApplicationMethod>(IDEBP_CONSUMER_LOCAL_METHODS);
const PLAN_STORE_METHODS = new Set<IDEBPApplicationMethod>([
  "refactor/prepare",
  "refactor/prepareRename",
  "workspace/applyPlan",
  "workspace/discardPlan",
  "workspace/undo",
]);
const ROUTED_METHODS = new Set<IDEBPApplicationMethod>(
  IDEBP_ROUTED_METHODS.filter((method) => !PLAN_STORE_METHODS.has(method)),
);

const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;
const MAX_ROUTE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_IN_FLIGHT = 1_024;
const DEFAULT_MAX_IN_FLIGHT_PER_CONSUMER = 128;
const CANCELLED_ROUTE_GRACE_MS = 30_000;
const MAX_ROUTED_DOCUMENT_SYMBOLS = 5_000;
const MAX_ROUTED_SYMBOL_DEPTH = 64;
const SYMBOL_RESULT_METHODS = new Set<IDEBPApplicationMethod>([
  "document/getSymbols",
  "workspace/searchSymbols",
  "symbol/resolveAt",
]);
const SYMBOL_LOCATION_METHODS = new Set<IDEBPApplicationMethod>([
  "symbol/getDefinition",
  "symbol/getReferences",
  "symbol/getImplementations",
  // A hierarchy step answers with the same shape as a lookup — neighbours in one relation — so it
  // inherits the same containment and handle-authority checks rather than getting its own.
  "symbol/getHierarchy",
]);

type SafeErrorCode =
  | RegistryErrorCode
  | "ADAPTER_DISCONNECTED"
  | "CAPABILITY_UNAVAILABLE"
  | "CANCELLED"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "PLAN_EXPIRED"
  | "PLAN_NOT_FOUND"
  | "PROVIDER_FAILED"
  // Safe for the same reason `STALE_SYMBOL` is: it describes the consumer's own edit, and names
  // nothing about the workspace it does not already know. Its absence made an invalidated plan
  // indistinguishable from a mistyped id.
  | "STALE_DOCUMENT"
  | "STALE_SYMBOL"
  | "TIMEOUT";

interface RouteRecord {
  routeId: string;
  method: IDEBPApplicationMethod;
  workspaceId: WorkspaceId;
  targetDocumentUri?: string;
  searchLimit?: number;
  consumerId: JSONRPCRequestIdentifier;
  consumerSessionId: SessionId;
  consumerConnection: AuthenticatedTransportConnection;
  adapterSessionId: SessionId;
  adapterConnection: AuthenticatedTransportConnection;
  state: "active" | "cancelled";
  expiration: ReturnType<typeof setTimeout>;
  editOperation:
    | { kind: "none" }
    | { kind: "prepare" }
    | { kind: "apply"; stored: StoredPlan }
    | { kind: "discard"; stored: StoredPlan }
    | { kind: "undo"; stored: StoredUndoToken };
}

export interface ApplicationRouterOptions {
  now?: () => Date;
  routeTimeoutMs?: number;
  maxInFlight?: number;
  maxInFlightPerConsumer?: number;
  createRouteId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function errorMessage(code: SafeErrorCode): string {
  const messages: Record<SafeErrorCode, string> = {
    ADAPTER_DISCONNECTED: "Adapter disconnected",
    ADAPTER_NOT_FOUND: "Adapter not found",
    CAPABILITY_UNAVAILABLE: "Capability is not available",
    CANCELLED: "Request cancelled",
    INTERNAL_ERROR: "Internal daemon error",
    INVALID_REQUEST: "Invalid application request",
    PLAN_EXPIRED: "Plan expired",
    PLAN_NOT_FOUND: "Plan not found",
    PERMISSION_DENIED: "Operation not permitted",
    PRECONDITION_FAILED: "Request precondition failed",
    PROVIDER_FAILED: "IDE provider failed",
    STALE_DOCUMENT: "Document changed after the plan was prepared",
    STALE_SYMBOL: "Symbol handle is stale",
    TIMEOUT: "Request timed out",
    WORKSPACE_NOT_FOUND: "Workspace not found",
  };
  return messages[code];
}

function numericErrorCode(code: SafeErrorCode): -32600 | -32000 {
  return code === "INVALID_REQUEST" ? -32600 : -32000;
}

/**
 * The one refusal that carries a fact rather than only a name.
 *
 * Built separately from [createErrorResponse] because its data shape is different: the protocol
 * requires `currentRevision`, and a generic builder that filled it with `undefined` would satisfy
 * the type and mislead the reader. Not retryable — the same request will fail the same way until
 * the caller prepares against the revision named here.
 */
function createStaleDocumentResponse(
  id: JSONRPCRequestIdentifier,
  stale: StalePlanReason,
): IDEBPJSONRPCErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: errorMessage("STALE_DOCUMENT"),
      data: {
        code: "STALE_DOCUMENT",
        retryable: false,
        details: {
          workspaceId: stale.workspaceId,
          documentUri: stale.uri,
          currentRevision: stale.currentRevision,
        },
      },
    },
  };
}

/**
 * The hard ceiling RFC 6455 puts on a close frame's reason: 125 bytes of payload, two of which are
 * the status code.
 */
const CLOSE_REASON_LIMIT_BYTES = 123;

/**
 * Clamp a close reason to what a close frame can actually carry.
 *
 * Exceeding the limit does not truncate the reason — it makes `close()` throw, so the session stays
 * open and the peer that violated the contract is never disconnected. A refusal that fails to
 * disconnect is worse than a terse one, so the text yields and the disconnection is guaranteed.
 * Truncation respects code-point boundaries: a half-written character would corrupt the frame.
 */
function clampCloseReason(reason: string): string {
  if (Buffer.byteLength(reason, "utf8") <= CLOSE_REASON_LIMIT_BYTES) {
    return reason;
  }
  const ellipsis = "…";
  const budget = CLOSE_REASON_LIMIT_BYTES - Buffer.byteLength(ellipsis, "utf8");
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.from(reason, "utf8").subarray(0, budget),
  );
  return `${truncated.replace(/�+$/u, "")}${ellipsis}`;
}

/**
 * Why a routed non-edit response was refused.
 *
 * These paths used to discard the thrown error and close with a fixed string, which told an adapter
 * author that something in a symbol or diagnostics payload was rejected but never which rule. The
 * named condition is appended when there is one, and the whole thing is clamped like any close
 * reason.
 */
function routedRejectionReason(summary: string, error: unknown): string {
  const reason = error instanceof EditStoreError ? error.reason : undefined;
  return clampCloseReason(reason === undefined ? summary : `${summary}: ${reason}`);
}

/**
 * Why an adapter's edit response was refused, in words its author can act on.
 *
 * Carries the rule and the operation, never the payload: a rejection often concerns a document, and
 * naming its contents here would put file text into a close frame.
 */
function editRejectionReason(method: string, operation: string, error: unknown): string {
  const cause =
    error instanceof EditStoreError
      ? `${error.code}${error.reason === undefined ? "" : ` (${error.reason})`}`
      : error instanceof Error
        ? error.message.slice(0, 60)
        : "unknown";
  return clampCloseReason(
    `Adapter ${method} result rejected during ${operation} transformation: ${cause}`,
  );
}

/**
 * `STALE_DOCUMENT` is excluded because it cannot be built here: the protocol requires it to carry
 * the document's current revision, which this signature has no way to know. `createStaleDocumentResponse`
 * builds that one, and the type stops the two from being confused.
 */
function createErrorResponse(
  id: JSONRPCRequestIdentifier,
  code: Exclude<SafeErrorCode, "STALE_DOCUMENT">,
  details?: { adapterId?: AdapterId; workspaceId?: WorkspaceId },
): IDEBPJSONRPCErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: numericErrorCode(code),
      message: errorMessage(code),
      data: {
        code,
        retryable: code === "TIMEOUT" || code === "ADAPTER_DISCONNECTED",
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

function requestKey(sessionId: SessionId, id: JSONRPCRequestIdentifier): string {
  return `${sessionId}\u0000${typeof id}:${String(id)}`;
}

function requestWorkspaceId(
  request: IDEBPApplicationRequestByMethod[IDEBPApplicationMethod],
): WorkspaceId | undefined {
  const params = request.params;
  if (!isRecord(params)) return undefined;
  const workspaceId = (params as unknown as Record<string, unknown>)["workspaceId"];
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

/**
 * The snapshot, in the mutable shape the wire type declares.
 *
 * Copied rather than cast. The registry hands out `readonly` arrays on purpose — a reader must not be
 * able to mutate the daemon's counters by holding its snapshot — and a cast would have thrown that away
 * to save four lines.
 */
function mutableMetrics(snapshot: MetricsSnapshot) {
  return {
    methods: [...snapshot.methods],
    refusals: [...snapshot.refusals],
    incomplete: [...snapshot.incomplete],
    queries: [...snapshot.queries],
    queryRingCapacity: snapshot.queryRingCapacity,
  };
}

/** The query a search request carried, when it carried one. */
function requestSearchQuery(
  request: IDEBPApplicationRequestByMethod[IDEBPApplicationMethod],
): string | undefined {
  const params = request.params;
  if (!isRecord(params)) return undefined;
  const query = (params as unknown as Record<string, unknown>)["query"];
  return typeof query === "string" ? query : undefined;
}

/** The normalized code a refusal carries, or `undefined` when the response is not one. */
function refusalCode(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const error = response["error"];
  if (!isRecord(error)) return undefined;
  const data = error["data"];
  if (!isRecord(data)) return undefined;
  const code = data["code"];
  return typeof code === "string" ? code : undefined;
}

/** Whether a result said the workspace holds more than the response carries. */
function carriesTruncation(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const result = response["result"];
  if (!isRecord(result)) return false;
  return result["truncated"] === true;
}

function requestDocumentUri(
  request: IDEBPApplicationRequestByMethod[IDEBPApplicationMethod],
): string | undefined {
  const params = request.params;
  if (!isRecord(params)) return undefined;
  const uri = (params as unknown as Record<string, unknown>)["uri"];
  return typeof uri === "string" ? uri : undefined;
}

function requestSymbolHandle(
  request: IDEBPApplicationRequestByMethod[IDEBPApplicationMethod],
): { adapterId: AdapterId; sessionId: SessionId; validUntilEpoch: number } | undefined {
  if (!isRecord(request.params)) return undefined;
  const symbol = (request.params as unknown as Record<string, unknown>)["symbol"];
  if (!isRecord(symbol)) return undefined;
  const handle = symbol["handle"];
  if (!isRecord(handle)) return undefined;
  const adapterId = handle["adapterId"];
  const sessionId = handle["sessionId"];
  const validUntilEpoch = handle["validUntilEpoch"];
  if (
    typeof adapterId !== "string" ||
    typeof sessionId !== "string" ||
    !Number.isSafeInteger(validUntilEpoch)
  ) {
    return undefined;
  }
  return { adapterId, sessionId, validUntilEpoch: Number(validUntilEpoch) };
}

/**
 * An editor version proves an edit landed in a live buffer, but it exists only while a document is
 * open (ADR-0020). When either side lacks one — a plan prepared against a file on disk, or a result
 * for a document that is not open — the content hashes are the proof, and they are checked
 * separately. Comparing an absent version against a present one would reject correct results.
 */
function editorVersionAdvanced(
  precondition: { editorVersion?: number } | undefined,
  revision: { editorVersion?: number },
): boolean {
  if (precondition?.editorVersion === undefined || revision.editorVersion === undefined)
    return true;
  return revision.editorVersion > precondition.editorVersion;
}

function requestSearchLimit(
  request: IDEBPApplicationRequestByMethod[IDEBPApplicationMethod],
): number {
  if (!isRecord(request.params)) return IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT;
  const limit = (request.params as unknown as Record<string, unknown>)["limit"];
  if (!Number.isSafeInteger(limit)) return IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT;
  return Math.min(Number(limit), IDEBP_MAX_SYMBOL_SEARCH_LIMIT);
}

/**
 * Bounds a routed symbol payload before recursive schema validation, which would otherwise consume
 * unbounded stack or CPU on a deep or oversized tree.
 */
function routedSymbolsWithinBounds(value: Record<string, unknown>): boolean {
  const result = value["result"];
  if (!isRecord(result)) return true;
  const locations = result["locations"];
  if (isUnknownArray(locations) && locations.length > IDEBP_MAX_SYMBOL_LOCATIONS) return false;
  const single = result["symbol"];
  const symbols = isUnknownArray(result["symbols"])
    ? result["symbols"]
    : single === undefined
      ? undefined
      : [single];
  if (!isUnknownArray(symbols)) return true;
  const pending = symbols.map((symbol) => ({ symbol, depth: 0 }));
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    count += 1;
    if (count > MAX_ROUTED_DOCUMENT_SYMBOLS || current.depth > MAX_ROUTED_SYMBOL_DEPTH) {
      return false;
    }
    if (!isRecord(current.symbol)) continue;
    const children = current.symbol["children"];
    if (!isUnknownArray(children)) continue;
    for (const child of children) pending.push({ symbol: child, depth: current.depth + 1 });
  }
  return true;
}

export class ApplicationRouter {
  readonly editStore: InMemoryEditStore;

  /**
   * What the daemon can say about its own traffic (ADR-0035).
   *
   * Owned here rather than injected: the router is the one place that sees every method, every refusal
   * code and every `truncated` flag, so anywhere else would be counting at second hand. Read through
   * `snapshot()`, which hands out a copy.
   */
  readonly metrics = new MetricsRegistry();
  readonly #registry: SessionRegistry;
  readonly #startedAt: Date;
  readonly #now: () => Date;
  readonly #routeTimeoutMs: number;
  readonly #maxInFlight: number;
  readonly #maxInFlightPerConsumer: number;
  readonly #createRouteId: () => string;
  readonly #routes = new Map<string, RouteRecord>();
  readonly #consumerRequests = new Map<string, string>();

  constructor(registry: SessionRegistry, options: ApplicationRouterOptions = {}) {
    this.#registry = registry;
    this.editStore = new InMemoryEditStore(options.now === undefined ? {} : { now: options.now });
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now();
    this.#routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#maxInFlightPerConsumer =
      options.maxInFlightPerConsumer ?? DEFAULT_MAX_IN_FLIGHT_PER_CONSUMER;
    this.#createRouteId =
      options.createRouteId ?? (() => `route_${randomBytes(18).toString("base64url")}`);
    if (
      !Number.isSafeInteger(this.#routeTimeoutMs) ||
      this.#routeTimeoutMs < 1 ||
      this.#routeTimeoutMs > MAX_ROUTE_TIMEOUT_MS ||
      !Number.isSafeInteger(this.#maxInFlight) ||
      this.#maxInFlight < 1 ||
      !Number.isSafeInteger(this.#maxInFlightPerConsumer) ||
      this.#maxInFlightPerConsumer < 1 ||
      this.#maxInFlightPerConsumer > this.#maxInFlight
    ) {
      throw new Error("Application router limits are invalid");
    }
  }

  async handle(connection: AuthenticatedTransportConnection, value: unknown): Promise<void> {
    this.#registry.touch(connection.session.sessionId);
    if (isRecord(value) && Object.hasOwn(value, "method")) {
      if (isJSONRPCRequestIdentifier(value["id"])) {
        await this.#handleRequest(connection, value);
      } else {
        await this.#handleNotification(connection, value);
      }
      return;
    }
    await this.#handleResponse(connection, value);
  }

  sessionClosed(
    connection: AuthenticatedTransportConnection,
    reason: SessionCloseReason = "transport-lost",
  ): void {
    const session = connection.session;
    this.editStore.invalidateSession(session.sessionId);
    const removed = this.#registry.close(session.sessionId);
    if (removed === undefined) return;

    for (const route of [...this.#routes.values()]) {
      if (route.adapterSessionId === session.sessionId) {
        this.#removeRoute(route);
        if (route.state === "active") {
          void route.consumerConnection
            .send(
              createErrorResponse(route.consumerId, "ADAPTER_DISCONNECTED", {
                workspaceId: route.workspaceId,
              }),
            )
            .catch(() => undefined);
        }
      } else if (route.consumerSessionId === session.sessionId) {
        this.#cancelRoute(route);
      }
    }

    if (removed.adapter !== undefined) {
      const notification = {
        jsonrpc: "2.0",
        method: "adapter/disconnected",
        params: { adapterId: removed.adapter.adapterId, reason },
      } as const;
      void this.#broadcast(notification);
    }
  }

  async #handleRequest(
    connection: AuthenticatedTransportConnection,
    value: Record<string, unknown>,
  ): Promise<void> {
    const id = value["id"];
    if (!isJSONRPCRequestIdentifier(id)) return;
    const methodValue = value["method"];
    if (
      typeof methodValue !== "string" ||
      !isIDEBPApplicationMethod(methodValue) ||
      !isIDEBPApplicationRequest(methodValue, value)
    ) {
      await connection.send(createErrorResponse(id, "INVALID_REQUEST"));
      return;
    }
    const method = methodValue;
    const role = connection.session.role;
    if (role === "adapter" && ADAPTER_REQUEST_METHODS.has(method)) {
      await this.#handleAdapterRequest(connection, method, value, id);
      return;
    }
    if (role === "consumer" && CONSUMER_LOCAL_METHODS.has(method)) {
      await this.#handleConsumerLocalRequest(connection, method, value, id);
      return;
    }
    if (role === "consumer" && ROUTED_METHODS.has(method)) {
      await this.#routeRequest(connection, method, value, id);
      return;
    }
    if (role === "consumer" && PLAN_STORE_METHODS.has(method)) {
      await this.#routeEditRequest(connection, method, value, id);
      return;
    }
    await connection.send(createErrorResponse(id, "PERMISSION_DENIED"));
  }

  async #handleAdapterRequest(
    connection: AuthenticatedTransportConnection,
    method: IDEBPApplicationMethod,
    value: Record<string, unknown>,
    id: JSONRPCRequestIdentifier,
  ): Promise<void> {
    try {
      switch (method) {
        case "ide/register": {
          const request = value as unknown as IDEBPApplicationRequestByMethod["ide/register"];
          const result = this.#registry.registerAdapter(
            connection.session.sessionId,
            request.params,
          );
          await this.#sendResult(connection, method, id, result);
          return;
        }
        case "ide/unregister": {
          const request = value as unknown as IDEBPApplicationRequestByMethod["ide/unregister"];
          this.#registry.unregisterAdapter(connection.session.sessionId, request.params.adapterId);
          this.editStore.invalidateSession(connection.session.sessionId);
          this.#adapterUnavailable(connection.session.sessionId, request.params.adapterId);
          await this.#sendResult(connection, method, id, {
            adapterId: request.params.adapterId,
            unregistered: true,
          });
          await this.#broadcast({
            jsonrpc: "2.0",
            method: "adapter/disconnected",
            params: { adapterId: request.params.adapterId, reason: "shutdown" },
          });
          return;
        }
        case "ide/ping": {
          const request = value as unknown as IDEBPApplicationRequestByMethod["ide/ping"];
          await this.#sendResult(connection, method, id, {
            sentAt: request.params.sentAt,
            receivedAt: this.#now().toISOString(),
          });
          return;
        }
      }
    } catch (error) {
      await this.#sendMappedError(connection, id, error, method);
    }
  }

  async #handleConsumerLocalRequest(
    connection: AuthenticatedTransportConnection,
    method: IDEBPApplicationMethod,
    value: Record<string, unknown>,
    id: JSONRPCRequestIdentifier,
  ): Promise<void> {
    try {
      switch (method) {
        case "bridge/getStatus":
          await this.#sendResult(connection, method, id, this.status());
          return;
        case "bridge/listAdapters":
          await this.#sendResult(connection, method, id, {
            adapters: this.#registry.listAdapters(),
          });
          return;
        case "bridge/listSessions":
          await this.#sendResult(connection, method, id, {
            sessions: this.#registry.listSessions(),
          });
          return;
        case "workspace/list": {
          const request = value as unknown as IDEBPApplicationRequestByMethod["workspace/list"];
          await this.#sendResult(connection, method, id, {
            workspaces: this.#registry.listWorkspaces(request.params.adapterId),
          });
          return;
        }
        case "workspace/get": {
          const request = value as unknown as IDEBPApplicationRequestByMethod["workspace/get"];
          await this.#sendResult(connection, method, id, {
            workspace: this.#registry.getWorkspace(request.params.workspaceId),
          });
          return;
        }
        case "workspace/getStatus": {
          const request =
            value as unknown as IDEBPApplicationRequestByMethod["workspace/getStatus"];
          await this.#sendResult(connection, method, id, {
            status: this.#registry.getWorkspaceStatus(request.params.workspaceId),
          });
          return;
        }
        case "ide/getCapabilities": {
          const request =
            value as unknown as IDEBPApplicationRequestByMethod["ide/getCapabilities"];
          await this.#sendResult(
            connection,
            method,
            id,
            this.#registry.getCapabilities(request.params.adapterId, request.params.workspaceId),
          );
          return;
        }
      }
    } catch (error) {
      await this.#sendMappedError(connection, id, error, method);
    }
  }

  async #routeRequest(
    consumerConnection: AuthenticatedTransportConnection,
    method: IDEBPApplicationMethod,
    value: Record<string, unknown>,
    consumerId: JSONRPCRequestIdentifier,
    editOperation: RouteRecord["editOperation"] = { kind: "none" },
  ): Promise<boolean> {
    const request = value as unknown as IDEBPApplicationRequestByMethod[IDEBPApplicationMethod];
    const workspaceId = requestWorkspaceId(request);
    if (workspaceId === undefined) {
      await consumerConnection.send(createErrorResponse(consumerId, "INVALID_REQUEST"));
      return false;
    }
    const consumerSessionId = consumerConnection.session.sessionId;
    const key = requestKey(consumerSessionId, consumerId);
    const consumerRouteCount = [...this.#routes.values()].filter(
      (route) => route.consumerSessionId === consumerSessionId && route.state === "active",
    ).length;
    if (
      this.#consumerRequests.has(key) ||
      this.#routes.size >= this.#maxInFlight ||
      consumerRouteCount >= this.#maxInFlightPerConsumer
    ) {
      await consumerConnection.send(createErrorResponse(consumerId, "PRECONDITION_FAILED"));
      return false;
    }

    let adapterConnection: AuthenticatedTransportConnection;
    try {
      adapterConnection = this.#registry.getWorkspaceConnection(workspaceId);
    } catch (error) {
      await this.#sendMappedError(consumerConnection, consumerId, error, method, { workspaceId });
      return false;
    }
    const workspace = this.#registry.getWorkspace(workspaceId);
    if (editOperation.kind === "none" || editOperation.kind === "prepare") {
      const capability = this.#registry.getCapabilities(workspace.adapterId, workspaceId)
        .capabilities[method];
      if (capability === undefined || capability.support === "unavailable") {
        await consumerConnection.send(
          createErrorResponse(consumerId, "CAPABILITY_UNAVAILABLE", {
            adapterId: workspace.adapterId,
            workspaceId,
          }),
        );
        return false;
      }
    }
    const handle = requestSymbolHandle(request);
    if (
      handle !== undefined &&
      (handle.adapterId !== workspace.adapterId ||
        handle.sessionId !== adapterConnection.session.sessionId ||
        handle.validUntilEpoch < workspace.workspaceEpoch)
    ) {
      await consumerConnection.send(
        createErrorResponse(consumerId, "STALE_SYMBOL", {
          adapterId: workspace.adapterId,
          workspaceId,
        }),
      );
      return false;
    }
    const routeId = this.#nextRouteId();
    const forwarded = { ...value, id: routeId };
    if (!isIDEBPApplicationRequest(method, forwarded)) {
      await consumerConnection.send(createErrorResponse(consumerId, "INTERNAL_ERROR"));
      return false;
    }
    const expiration = setTimeout(() => {
      const route = this.#routes.get(routeId);
      if (route === undefined || route.state !== "active") return;
      this.#consumerRequests.delete(key);
      route.state = "cancelled";
      void route.consumerConnection
        .send(createErrorResponse(route.consumerId, "TIMEOUT", { workspaceId }))
        .catch(() => undefined);
      this.#sendCancellation(route);
      this.#scheduleRouteRemoval(route);
    }, this.#routeTimeoutMs);
    expiration.unref();
    const targetDocumentUri = requestDocumentUri(request);
    const searchLimit =
      method === "workspace/searchSymbols" ? requestSearchLimit(request) : undefined;
    if (method === "workspace/searchSymbols") {
      // Kept as text, in memory, capped and forgettable — the reasoning and its constraints are in
      // ADR-0035. A count would say "47 searches"; this says what the agent is looking for.
      const query = requestSearchQuery(request);
      if (query !== undefined) this.metrics.recordQuery(query, method);
    }
    const route: RouteRecord = {
      routeId,
      method,
      workspaceId,
      ...(targetDocumentUri === undefined ? {} : { targetDocumentUri }),
      ...(searchLimit === undefined ? {} : { searchLimit }),
      consumerId,
      consumerSessionId,
      consumerConnection,
      adapterSessionId: adapterConnection.session.sessionId,
      adapterConnection,
      state: "active",
      expiration,
      editOperation,
    };
    this.#routes.set(routeId, route);
    this.#consumerRequests.set(key, routeId);
    try {
      await adapterConnection.send(forwarded);
      return true;
    } catch {
      this.#removeRoute(route);
      await consumerConnection.send(
        createErrorResponse(consumerId, "ADAPTER_DISCONNECTED", { workspaceId }),
      );
      return false;
    }
  }

  async #routeEditRequest(
    connection: AuthenticatedTransportConnection,
    method: IDEBPApplicationMethod,
    value: Record<string, unknown>,
    id: JSONRPCRequestIdentifier,
  ): Promise<void> {
    const sessionId = connection.session.sessionId;
    try {
      // Both preparation methods route identically: they ask an adapter for a plan and store it.
      // `refactor/prepare` was added to PLAN_STORE_METHODS — which excludes it from ROUTED_METHODS —
      // without a case here, so it fell through and returned nothing at all: no route, no response,
      // and not even the route timeout that would have made the silence visible. A consumer waited
      // forever. Nothing caught it because no test drove the method over the wire.
      if (method === "refactor/prepareRename" || method === "refactor/prepare") {
        await this.#routeRequest(connection, method, value, id, { kind: "prepare" });
        return;
      }
      if (method === "workspace/applyPlan") {
        const request = value as unknown as IDEBPApplicationRequestByMethod[typeof method];
        const workspace = this.#registry.getWorkspace(request.params.workspaceId);
        if (workspace.trust !== "trusted") {
          await connection.send(createErrorResponse(id, "PERMISSION_DENIED"));
          return;
        }
        const stored = this.editStore.consumePlan(
          request.params.planId,
          sessionId,
          request.params.workspaceId,
          workspace.workspaceEpoch,
        );
        try {
          this.#assertStoredAdapter(stored.adapterSessionId, request.params.workspaceId);
          const forwarded = {
            ...value,
            params: { ...request.params, planId: stored.adapterPlan.planId },
          };
          const routed = await this.#routeRequest(connection, method, forwarded, id, {
            kind: "apply",
            stored,
          });
          if (!routed) this.editStore.releasePlan(stored);
        } catch (error) {
          this.editStore.releasePlan(stored);
          throw error;
        }
        return;
      }
      if (method === "workspace/discardPlan") {
        const request = value as unknown as IDEBPApplicationRequestByMethod[typeof method];
        const stored = this.editStore.discardPlan(
          request.params.planId,
          sessionId,
          request.params.workspaceId,
        );
        try {
          this.#assertStoredAdapter(stored.adapterSessionId, request.params.workspaceId);
          const forwarded = {
            ...value,
            params: { ...request.params, planId: stored.adapterPlan.planId },
          };
          const routed = await this.#routeRequest(connection, method, forwarded, id, {
            kind: "discard",
            stored,
          });
          if (!routed) this.editStore.releasePlan(stored);
        } catch (error) {
          this.editStore.releasePlan(stored);
          throw error;
        }
        return;
      }
      if (method === "workspace/undo") {
        const request = value as unknown as IDEBPApplicationRequestByMethod[typeof method];
        const workspace = this.#registry.getWorkspace(request.params.workspaceId);
        if (workspace.trust !== "trusted") {
          await connection.send(createErrorResponse(id, "PERMISSION_DENIED"));
          return;
        }
        const stored = this.editStore.consumeUndoToken(
          request.params.undoToken,
          sessionId,
          request.params.workspaceId,
        );
        try {
          this.#assertStoredAdapter(stored.adapterSessionId, request.params.workspaceId);
          const forwarded = {
            ...value,
            params: { ...request.params, undoToken: stored.adapterToken },
          };
          const routed = await this.#routeRequest(connection, method, forwarded, id, {
            kind: "undo",
            stored,
          });
          if (!routed) this.editStore.releaseUndoToken(stored);
        } catch (error) {
          this.editStore.releaseUndoToken(stored);
          throw error;
        }
      }
    } catch (error) {
      await this.#sendMappedError(connection, id, error, method);
    }
  }

  async #handleResponse(
    connection: AuthenticatedTransportConnection,
    value: unknown,
  ): Promise<void> {
    if (connection.session.role !== "adapter" || !isRecord(value)) {
      connection.close(1002, "Unexpected IDEBP response");
      return;
    }
    const id = value["id"];
    if (typeof id !== "string") {
      connection.close(1002, "Invalid IDEBP response identifier");
      return;
    }
    const route = this.#routes.get(id);
    if (route === undefined || route.adapterSessionId !== connection.session.sessionId) {
      connection.close(1002, "Unknown IDEBP response identifier");
      return;
    }
    if (
      (SYMBOL_RESULT_METHODS.has(route.method) || SYMBOL_LOCATION_METHODS.has(route.method)) &&
      !routedSymbolsWithinBounds(value)
    ) {
      this.#removeRoute(route);
      await route.consumerConnection
        .send(
          createErrorResponse(route.consumerId, "PROVIDER_FAILED", {
            workspaceId: route.workspaceId,
          }),
        )
        .catch(() => undefined);
      connection.close(1008, "Unbounded routed symbols");
      return;
    }
    if (!isIDEBPJSONRPCErrorResponse(value) && !isIDEBPApplicationResponse(route.method, value)) {
      // Names the violated keyword and where it sits. Never the offending value: a response
      // routinely contains document text, and a close frame is not where that belongs.
      const why = describeApplicationResponseFailure(route.method, value);
      connection.close(
        1002,
        clampCloseReason(
          why === undefined
            ? "Invalid routed IDEBP response"
            : `Invalid routed ${route.method} response: ${why}`,
        ),
      );
      return;
    }
    if (!isIDEBPJSONRPCErrorResponse(value)) {
      try {
        this.#assertRoutedDocumentResult(route, value);
      } catch (error) {
        this.#removeRoute(route);
        await route.consumerConnection
          .send(
            createErrorResponse(route.consumerId, "PROVIDER_FAILED", {
              workspaceId: route.workspaceId,
            }),
          )
          .catch(() => undefined);
        connection.close(1008, routedRejectionReason("Invalid routed document result", error));
        return;
      }
    }
    this.#removeRoute(route);
    if (route.state === "cancelled") return;
    let response: unknown = { ...value, id: route.consumerId };
    if (route.editOperation.kind !== "none") {
      try {
        response = isIDEBPJSONRPCErrorResponse(value)
          ? this.#transformEditErrorResponse(route, value)
          : this.#transformEditResponse(route, value);
      } catch (error) {
        await route.consumerConnection.send(
          createErrorResponse(route.consumerId, "PROVIDER_FAILED", {
            workspaceId: route.workspaceId,
          }),
        );
        // Name the check that refused. A bare PROVIDER_FAILED tells an adapter author nothing, and
        // the close reason is the one channel that reaches them. It carries the failing rule and the
        // method, never any document content.
        connection.close(1008, editRejectionReason(route.method, route.editOperation.kind, error));
        return;
      }
    }
    if (
      (isIDEBPJSONRPCErrorResponse(value) && !isIDEBPJSONRPCErrorResponse(response)) ||
      (!isIDEBPJSONRPCErrorResponse(value) && !isIDEBPApplicationResponse(route.method, response))
    ) {
      await route.consumerConnection.send(
        createErrorResponse(route.consumerId, "PROVIDER_FAILED", {
          workspaceId: route.workspaceId,
        }),
      );
      connection.close(
        1008,
        `Edit response for ${route.method} did not match its response schema after transformation`,
      );
      return;
    }
    // The one place every routed answer passes through, so the one place worth counting: a refusal
    // carries the code an agent will act on, and a result may carry the flag that says the workspace
    // held more than the answer did (ADR-0035).
    const refusal = refusalCode(response);
    if (refusal !== undefined) {
      this.metrics.recordRefusal(refusal, route.method);
    } else if (carriesTruncation(response)) {
      this.metrics.recordIncomplete(route.method);
    }
    try {
      await route.consumerConnection.send(response);
    } catch {
      // The response owner disconnected after completion; the adapter remains healthy.
    }
  }

  #transformEditResponse(route: RouteRecord, value: Record<string, unknown>): unknown {
    const operation = route.editOperation;
    const result = value["result"] as Record<string, unknown>;
    if (operation.kind === "prepare") {
      const adapterPlan = result["plan"] as IDEBPResponseResult<"refactor/prepareRename">["plan"];
      const workspace = this.#registry.getWorkspace(route.workspaceId);
      const publicPlan = this.editStore.createPlan(adapterPlan, {
        consumerSessionId: route.consumerSessionId,
        adapterSessionId: route.adapterSessionId,
        adapterId: workspace.adapterId,
        workspaceId: route.workspaceId,
        workspaceEpoch: workspace.workspaceEpoch,
        workspaceRootUris: workspace.roots.map((root) => root.uri),
      });
      return { jsonrpc: "2.0", id: route.consumerId, result: { plan: publicPlan } };
    }
    if (operation.kind === "discard") {
      if (result["planId"] !== operation.stored.adapterPlan.planId) {
        throw new EditStoreError("PROVIDER_FAILED", "discarded an unrouted plan");
      }
      return {
        jsonrpc: "2.0",
        id: route.consumerId,
        result: { planId: operation.stored.publicPlan.planId, discarded: true },
      };
    }
    const modification = result as unknown as ModificationResult;
    const plan = operation.kind === "apply" ? operation.stored : undefined;
    this.#assertModifiedDocuments(route, modification.modifiedDocuments, plan, plan !== undefined);
    for (const diagnostics of modification.diagnostics ?? []) {
      this.#assertWorkspaceDocument(route.workspaceId, diagnostics.document);
    }
    const undoToken = modification.undoToken;
    let publicUndoToken;
    if (undoToken !== undefined) {
      try {
        publicUndoToken = this.editStore.createUndoToken(undoToken, {
          consumerSessionId: route.consumerSessionId,
          adapterSessionId: route.adapterSessionId,
          adapterId: this.#registry.getWorkspace(route.workspaceId).adapterId,
          workspaceId: route.workspaceId,
        });
      } catch (error) {
        if (!(error instanceof EditStoreError) || error.code !== "PRECONDITION_FAILED") throw error;
        // Applying already succeeded. If the bounded store is full, omit unsafe undo authority
        // instead of hiding the successful modification or exposing the adapter's private token.
      }
    }
    return {
      jsonrpc: "2.0",
      id: route.consumerId,
      result: {
        ...structuredClone(modification),
        ...(publicUndoToken === undefined ? {} : { undoToken: publicUndoToken }),
      },
    };
  }

  #transformEditErrorResponse(
    route: RouteRecord,
    value: IDEBPJSONRPCErrorResponse,
  ): IDEBPJSONRPCErrorResponse {
    const response = structuredClone(value);
    response.id = route.consumerId;
    const details = response.error.data.details;
    if (!isRecord(details)) return response;
    const detailsRecord = details as Record<string, unknown>;
    if (
      detailsRecord["workspaceId"] !== undefined &&
      detailsRecord["workspaceId"] !== route.workspaceId
    ) {
      throw new EditStoreError("PROVIDER_FAILED", "error names another workspace");
    }
    const operation = route.editOperation;
    const stored =
      operation.kind === "apply" || operation.kind === "discard" ? operation.stored : undefined;
    if (detailsRecord["planId"] !== undefined) {
      if (stored === undefined || detailsRecord["planId"] !== stored.adapterPlan.planId) {
        throw new EditStoreError("PROVIDER_FAILED", "error names an unrouted plan");
      }
      detailsRecord["planId"] = stored.publicPlan.planId;
    }
    if (response.error.data.code === "PARTIAL_APPLY") {
      if (operation.kind !== "apply" || !Array.isArray(detailsRecord["modifiedDocuments"])) {
        throw new EditStoreError("PROVIDER_FAILED", "malformed partial-apply details");
      }
      this.#assertModifiedDocuments(
        route,
        detailsRecord["modifiedDocuments"] as ModifiedDocument[],
        operation.stored,
        false,
      );
    }
    return response;
  }

  #assertModifiedDocuments(
    route: RouteRecord,
    modifiedDocuments: ModifiedDocument[],
    plan: StoredPlan | undefined,
    requireEveryPlannedDocument: boolean,
  ): void {
    const changeUris =
      plan === undefined ? undefined : new Set(plan.publicPlan.changes.map(({ uri }) => uri));
    const preconditions =
      plan === undefined
        ? undefined
        : new Map(plan.publicPlan.preconditions.map((item) => [item.uri, item]));
    const returnedUris = new Set<string>();
    for (const modified of modifiedDocuments) {
      const uri = modified.document.uri;
      const precondition = preconditions?.get(uri);
      // Each condition names itself. As one compound test they said only "rejected", which leaves an
      // adapter author nothing to act on — the failure mode this sweep exists to remove.
      if (returnedUris.has(uri)) {
        throw new EditStoreError("PROVIDER_FAILED", "the same document was reported twice");
      }
      if (changeUris !== undefined && !changeUris.has(uri)) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "a document was modified that the plan never named",
        );
      }
      if (preconditions !== undefined && precondition?.contentHash !== modified.beforeHash) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "the reported before-hash does not match the plan's precondition",
        );
      }
      if (!editorVersionAdvanced(precondition, modified.document.revision)) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "the editor version did not advance past the precondition",
        );
      }
      if (modified.document.revision.contentHash !== modified.afterHash) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "the document's revision hash disagrees with the reported after-hash",
        );
      }
      if (modified.beforeHash === modified.afterHash) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "a document was reported as modified but its content is unchanged",
        );
      }
      this.#assertWorkspaceDocument(route.workspaceId, modified.document);
      returnedUris.add(uri);
    }
    if (
      requireEveryPlannedDocument &&
      changeUris !== undefined &&
      (returnedUris.size !== changeUris.size ||
        [...changeUris].some((uri) => !returnedUris.has(uri)))
    ) {
      throw new EditStoreError(
        "PROVIDER_FAILED",
        "the plan named documents the result does not report",
      );
    }
  }

  #assertWorkspaceDocument(
    workspaceId: WorkspaceId,
    document: ModificationResult["modifiedDocuments"][number]["document"],
  ): void {
    const workspace = this.#registry.getWorkspace(workspaceId);
    const root = workspace.roots.find((candidate) => candidate.rootId === document.rootId);
    // Each condition names itself. Together they were a single unexplained refusal, which is the
    // hardest kind of failure to act on from the other side of the wire.
    if (document.workspaceId !== workspaceId) {
      throw new EditStoreError("PROVIDER_FAILED", "document belongs to another workspace");
    }
    if (document.revision.workspaceEpoch !== workspace.workspaceEpoch) {
      throw new EditStoreError(
        "PROVIDER_FAILED",
        `document revision is at epoch ${document.revision.workspaceEpoch}, workspace is at ${workspace.workspaceEpoch}`,
      );
    }
    if (root === undefined) {
      throw new EditStoreError(
        "PROVIDER_FAILED",
        "document names a root this workspace does not have",
      );
    }
    if (!isUriWithinWorkspaceRoot(document.uri, root.uri)) {
      throw new EditStoreError("PROVIDER_FAILED", "document uri falls outside the root it names");
    }
  }

  #assertRoutedDocumentResult(route: RouteRecord, value: Record<string, unknown>): void {
    if (route.method === "workspace/searchSymbols") {
      const searchResult = value["result"] as { symbols: IDEBPSymbol[] };
      this.#assertRoutedSearchSymbols(route, searchResult.symbols);
      return;
    }
    if (SYMBOL_LOCATION_METHODS.has(route.method)) {
      const lookupResult = value["result"] as { locations: SymbolLocation[] };
      this.#assertRoutedSymbolLocations(route, lookupResult.locations);
      return;
    }
    if (route.method === "diagnostics/getSnapshot") {
      const snapshot = value["result"] as { documents: DocumentDiagnostics[] };
      this.#assertRoutedDiagnostics(route, snapshot.documents);
      return;
    }
    if (
      route.method !== "document/read" &&
      route.method !== "document/getRevision" &&
      route.method !== "document/getSymbols" &&
      route.method !== "symbol/resolveAt"
    ) {
      return;
    }
    const result = value["result"] as {
      document: ModificationResult["modifiedDocuments"][number]["document"];
      symbol?: IDEBPSymbol;
      symbols?: IDEBPSymbol[];
    };
    this.#assertWorkspaceDocument(route.workspaceId, result.document);
    if (route.targetDocumentUri === undefined || result.document.uri !== route.targetDocumentUri) {
      throw new EditStoreError("PROVIDER_FAILED", "answered about a different document");
    }
    if (route.method === "document/getSymbols") {
      if (result.symbols === undefined) {
        throw new EditStoreError("PROVIDER_FAILED", "no symbols field in a getSymbols result");
      }
      this.#assertRoutedDocumentSymbols(route, result.symbols);
    }
    if (route.method === "symbol/resolveAt" && result.symbol !== undefined) {
      // An omitted symbol is the canonical "no symbol at this position" answer, not a failure.
      this.#assertRoutedDocumentSymbols(route, [result.symbol]);
    }
  }

  /**
   * Locations are read-only navigation results, so they carry no mandatory handle. Any handle a
   * result does include must still belong to the routed adapter session and the current epoch,
   * and every reported URI must stay inside a registered root.
   */
  #assertRoutedSymbolLocations(route: RouteRecord, locations: readonly SymbolLocation[]): void {
    const workspace = this.#registry.getWorkspace(route.workspaceId);
    if (locations.length > IDEBP_MAX_SYMBOL_LOCATIONS) {
      throw new EditStoreError("PROVIDER_FAILED", "more locations than the protocol allows");
    }
    const handles = new Set<string>();
    for (const entry of locations) {
      if (!workspace.roots.some((root) => isUriWithinWorkspaceRoot(entry.location.uri, root.uri))) {
        throw new EditStoreError("PROVIDER_FAILED", "a location falls outside every root");
      }
      const symbol = entry.symbol;
      if (symbol === undefined) continue;
      if (
        symbol.handle.adapterId !== workspace.adapterId ||
        symbol.handle.sessionId !== route.adapterSessionId ||
        symbol.handle.validUntilEpoch !== workspace.workspaceEpoch ||
        handles.has(symbol.handle.id) ||
        !workspace.roots.some((root) =>
          isUriWithinWorkspaceRoot(symbol.locator.documentUri, root.uri),
        )
      ) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "a document symbol has a foreign handle, a duplicate id, or a uri outside the request",
        );
      }
      handles.add(symbol.handle.id);
    }
  }

  #assertRoutedDocumentSymbols(route: RouteRecord, symbols: readonly IDEBPSymbol[]): void {
    const workspace = this.#registry.getWorkspace(route.workspaceId);
    const targetDocumentUri = route.targetDocumentUri;
    if (targetDocumentUri === undefined) {
      throw new EditStoreError("PROVIDER_FAILED", "symbols routed without a target document");
    }
    const handles = new Set<string>();
    const pending = symbols.map((symbol) => ({ symbol, depth: 0 }));
    let count = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      count += 1;
      const { symbol, depth } = current;
      if (
        count > MAX_ROUTED_DOCUMENT_SYMBOLS ||
        depth > MAX_ROUTED_SYMBOL_DEPTH ||
        symbol.handle.adapterId !== workspace.adapterId ||
        symbol.handle.sessionId !== route.adapterSessionId ||
        symbol.handle.validUntilEpoch !== workspace.workspaceEpoch ||
        handles.has(symbol.handle.id) ||
        symbol.locator.documentUri !== targetDocumentUri ||
        !workspace.roots.some((root) =>
          isUriWithinWorkspaceRoot(symbol.locator.documentUri, root.uri),
        )
      ) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "a symbol is too deep, too many, foreign, duplicated, or outside the document",
        );
      }
      handles.add(symbol.handle.id);
      for (const child of symbol.children) pending.push({ symbol: child, depth: depth + 1 });
    }
  }

  /**
   * A workspace symbol search spans every registered root instead of one requested document,
   * so it cannot reuse the document-symbol authority check. Each hit must still be owned by the
   * routed adapter session, carry the current epoch, be uniquely handled, stay flat, and point
   * inside a registered root. The result is additionally capped at the effective request limit.
   */
  #assertRoutedSearchSymbols(route: RouteRecord, symbols: readonly IDEBPSymbol[]): void {
    const workspace = this.#registry.getWorkspace(route.workspaceId);
    const limit = route.searchLimit ?? IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT;
    if (symbols.length > limit) {
      throw new EditStoreError("PROVIDER_FAILED", "more search hits than the request allowed");
    }
    const handles = new Set<string>();
    for (const symbol of symbols) {
      if (
        symbol.children.length > 0 ||
        symbol.handle.adapterId !== workspace.adapterId ||
        symbol.handle.sessionId !== route.adapterSessionId ||
        symbol.handle.validUntilEpoch !== workspace.workspaceEpoch ||
        handles.has(symbol.handle.id) ||
        !workspace.roots.some((root) =>
          isUriWithinWorkspaceRoot(symbol.locator.documentUri, root.uri),
        )
      ) {
        throw new EditStoreError(
          "PROVIDER_FAILED",
          "a search hit is nested, foreign, duplicated, or outside every root",
        );
      }
      handles.add(symbol.handle.id);
    }
  }

  /**
   * A diagnostics snapshot carries a document reference per entry and arbitrary related-information
   * locations inside each diagnostic. Every one of those URIs must stay inside a registered root,
   * or a snapshot becomes a channel for reporting paths the consumer has no access to.
   */
  #assertRoutedDiagnostics(route: RouteRecord, documents: readonly DocumentDiagnostics[]): void {
    if (documents.length > IDEBP_MAX_DIAGNOSTIC_DOCUMENTS) {
      throw new EditStoreError("PROVIDER_FAILED", "more diagnostic documents than allowed");
    }
    const seen = new Set<string>();
    for (const entry of documents) {
      if (
        entry.diagnostics.length > IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT ||
        seen.has(entry.document.uri)
      ) {
        throw new EditStoreError("PROVIDER_FAILED", "too many diagnostics, or a repeated document");
      }
      this.#assertWorkspaceDocument(route.workspaceId, entry.document);
      seen.add(entry.document.uri);
      for (const diagnostic of entry.diagnostics) {
        for (const related of diagnostic.relatedInformation ?? []) {
          this.#assertWorkspaceUri(route.workspaceId, related.location.uri);
        }
      }
    }
  }

  #assertWorkspaceUri(workspaceId: WorkspaceId, uri: string): void {
    const workspace = this.#registry.getWorkspace(workspaceId);
    if (!workspace.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri))) {
      throw new SessionRegistryError("PERMISSION_DENIED");
    }
  }

  async #handleNotification(
    connection: AuthenticatedTransportConnection,
    value: unknown,
  ): Promise<void> {
    const validation = classifyIDEBPNotification(value);
    if (validation.kind !== "valid") {
      connection.close(1002, "Invalid IDEBP notification");
      return;
    }
    if (validation.method === "$/cancelRequest") {
      if (connection.session.role !== "consumer") {
        connection.close(1008, "Unauthorized IDEBP notification");
        return;
      }
      const params = validation.notification.params as IDEBPNotificationParams<"$/cancelRequest">;
      const routeId = this.#consumerRequests.get(
        requestKey(connection.session.sessionId, params.id),
      );
      const route = routeId === undefined ? undefined : this.#routes.get(routeId);
      if (route !== undefined) this.#cancelRoute(route);
      return;
    }
    if (connection.session.role !== "adapter" || validation.method === "adapter/disconnected") {
      connection.close(1008, "Unauthorized IDEBP notification");
      return;
    }
    try {
      this.#applyAdapterNotification(
        connection.session.sessionId,
        validation.method,
        validation.notification.params,
      );
    } catch {
      connection.close(1008, "Unauthorized IDEBP notification");
      return;
    }
    await this.#broadcast(value);
  }

  #applyAdapterNotification(
    sessionId: SessionId,
    method: IDEBPNotificationMethod,
    params: unknown,
  ): void {
    switch (method) {
      case "adapter/capabilitiesChanged": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.updateCapabilities(sessionId, typed.adapterId, typed.capabilities);
        return;
      }
      case "workspace/opened": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.openWorkspace(sessionId, typed.workspace);
        return;
      }
      case "workspace/closed": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.editStore.invalidateWorkspace(typed.workspaceId);
        this.#registry.closeWorkspace(sessionId, typed.workspaceId, typed.adapterId);
        return;
      }
      case "workspace/rootsChanged": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.editStore.invalidateWorkspace(typed.workspaceId);
        this.#registry.updateWorkspaceRoots(
          sessionId,
          typed.workspaceId,
          typed.adapterId,
          typed.roots,
          typed.workspaceEpoch,
        );
        return;
      }
      case "workspace/readinessChanged": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.updateWorkspaceStatus(sessionId, typed.status);
        return;
      }
      case "workspace/trustChanged": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.updateWorkspaceTrust(
          sessionId,
          typed.workspaceId,
          typed.adapterId,
          typed.trust,
        );
        return;
      }
      case "document/deleted": {
        // A deleted document carries no revision — there is no content left to describe — so it
        // is validated by URI containment alone (ADR-0022).
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.assertWorkspaceOwnership(sessionId, typed.workspaceId);
        this.#assertWorkspaceUri(typed.workspaceId, typed.uri);
        this.editStore.invalidateDocument(typed.workspaceId, typed.uri);
        return;
      }
      case "document/opened":
      case "document/changed":
      case "document/saved":
      case "document/closed": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.assertWorkspaceOwnership(sessionId, typed.document.workspaceId);
        this.#assertWorkspaceDocument(typed.document.workspaceId, typed.document);
        if (method === "document/changed") {
          // The new revision travels with the invalidation so the refusal can name it. A consumer
          // told only "stale" has to guess what to re-read.
          this.editStore.invalidateDocument(
            typed.document.workspaceId,
            typed.document.uri,
            typed.document.revision,
          );
        }
        return;
      }
      case "document/renamed": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.assertWorkspaceOwnership(sessionId, typed.workspaceId);
        if (typed.document.workspaceId !== typed.workspaceId) {
          throw new SessionRegistryError("PERMISSION_DENIED");
        }
        this.#assertWorkspaceDocument(typed.workspaceId, typed.document);
        this.#assertWorkspaceUri(typed.workspaceId, typed.previousUri);
        this.editStore.invalidateDocument(typed.workspaceId, typed.previousUri);
        this.editStore.invalidateDocument(typed.workspaceId, typed.document.uri);
        return;
      }
      case "diagnostics/changed": {
        const typed = params as IDEBPNotificationParams<typeof method>;
        this.#registry.assertWorkspaceOwnership(sessionId, typed.workspaceId);
        // Without this the notification would broadcast any URI the adapter names, including paths
        // outside every registered root, to every consumer.
        this.#assertWorkspaceUri(typed.workspaceId, typed.documentUri);
        if (
          typed.revision.workspaceEpoch !==
          this.#registry.getWorkspace(typed.workspaceId).workspaceEpoch
        ) {
          throw new SessionRegistryError("PRECONDITION_FAILED");
        }
        return;
      }
      case "adapter/disconnected":
      case "$/cancelRequest":
        throw new SessionRegistryError("PERMISSION_DENIED");
    }
  }

  /**
   * What the daemon says about itself.
   *
   * Public because the dashboard surface shows the same thing (ADR-0035), and two assemblies of one
   * answer drift: the panel would eventually disagree with `bridge/getStatus` about the same daemon.
   *
   * The metrics ride here rather than behind a new method because a new method name is compared against
   * the Kotlin catalogue, which would have made a read-only local counter a cross-language protocol
   * change. Optional in the schema, so a daemon keeping no counters omits the field instead of reporting
   * zeroes that read like an idle daemon.
   */
  status() {
    return {
      daemonVersion: DAEMON_VERSION,
      protocol: { minimum: PROTOCOL_VERSION, maximum: PROTOCOL_VERSION },
      startedAt: this.#startedAt.toISOString(),
      uptimeMs: Math.max(0, this.#now().getTime() - this.#startedAt.getTime()),
      adapterCount: this.#registry.adapterCount,
      workspaceCount: this.#registry.workspaceCount,
      sessionCount: this.#registry.sessionCount,
      metrics: mutableMetrics(this.metrics.snapshot()),
    };
  }

  async #sendResult<M extends IDEBPApplicationMethod>(
    connection: AuthenticatedTransportConnection,
    method: M,
    id: JSONRPCRequestIdentifier,
    result: IDEBPResponseResult<M>,
  ): Promise<void> {
    const response: unknown = { jsonrpc: "2.0", id, result };
    if (!isIDEBPApplicationResponse(method, response)) {
      throw new Error("Daemon created an invalid IDEBP response");
    }
    await connection.send(response);
  }

  async #sendMappedError(
    connection: AuthenticatedTransportConnection,
    id: JSONRPCRequestIdentifier,
    error: unknown,
    method: IDEBPApplicationMethod,
    details?: { adapterId?: AdapterId; workspaceId?: WorkspaceId },
  ): Promise<void> {
    const code =
      error instanceof SessionRegistryError || error instanceof EditStoreError
        ? error.code
        : "INTERNAL_ERROR";
    // `STALE_DOCUMENT` is the one refusal whose protocol data requires more than a name: the
    // revision the document now has, so the caller can re-read exactly that and prepare again.
    if (error instanceof EditStoreError && error.stale !== undefined) {
      this.metrics.recordRefusal(code, method);
      await connection.send(createStaleDocumentResponse(id, error.stale));
      return;
    }
    // Only reachable if a `STALE_DOCUMENT` were raised without the revision its data requires,
    // which the store never does — the two are constructed together. Answering `PLAN_NOT_FOUND`
    // rather than an ill-formed `STALE_DOCUMENT` keeps the response valid; the plan is, after all,
    // genuinely gone.
    const safe = code === "STALE_DOCUMENT" ? "PLAN_NOT_FOUND" : code;
    // Attributed to the method, which every caller of this knows. An earlier version left it
    // unattributed and justified that by the signature not carrying a method — true of the signature,
    // false of its callers, and it left the per-method refusal column empty for every refusal the
    // daemon itself produces.
    this.metrics.recordRefusal(safe, method);
    await connection.send(createErrorResponse(id, safe, details));
  }

  async #broadcast(notification: unknown): Promise<void> {
    await Promise.allSettled(
      this.#registry.consumerConnections().map(async (connection) => {
        await connection.send(notification);
      }),
    );
  }

  #nextRouteId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.#createRouteId();
      if (
        /^route_[A-Za-z0-9_-]+$/u.test(id) &&
        isJSONRPCRequestIdentifier(id) &&
        !this.#routes.has(id)
      ) {
        return id;
      }
    }
    throw new Error("Route ID factory could not create a unique valid ID");
  }

  #cancelRoute(route: RouteRecord): void {
    if (route.state === "cancelled") return;
    this.#consumerRequests.delete(requestKey(route.consumerSessionId, route.consumerId));
    route.state = "cancelled";
    clearTimeout(route.expiration);
    this.#sendCancellation(route);
    this.#scheduleRouteRemoval(route);
  }

  #sendCancellation(route: RouteRecord): void {
    void route.adapterConnection
      .send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: route.routeId } })
      .catch(() => undefined);
  }

  #scheduleRouteRemoval(route: RouteRecord): void {
    clearTimeout(route.expiration);
    route.expiration = setTimeout(() => {
      this.#removeRoute(route);
    }, CANCELLED_ROUTE_GRACE_MS);
    route.expiration.unref();
  }

  #removeRoute(route: RouteRecord): void {
    clearTimeout(route.expiration);
    this.#routes.delete(route.routeId);
    this.#consumerRequests.delete(requestKey(route.consumerSessionId, route.consumerId));
    if (route.editOperation.kind === "apply" || route.editOperation.kind === "discard") {
      this.editStore.releasePlan(route.editOperation.stored);
    } else if (route.editOperation.kind === "undo") {
      this.editStore.releaseUndoToken(route.editOperation.stored);
    }
  }

  #adapterUnavailable(sessionId: SessionId, adapterId: AdapterId): void {
    for (const route of [...this.#routes.values()]) {
      if (route.adapterSessionId !== sessionId) continue;
      this.#removeRoute(route);
      if (route.state === "active") {
        void route.consumerConnection
          .send(
            createErrorResponse(route.consumerId, "ADAPTER_DISCONNECTED", {
              adapterId,
              workspaceId: route.workspaceId,
            }),
          )
          .catch(() => undefined);
      }
    }
  }

  #assertStoredAdapter(adapterSessionId: SessionId, workspaceId: WorkspaceId): void {
    if (this.#registry.getWorkspaceConnection(workspaceId).session.sessionId !== adapterSessionId) {
      throw new EditStoreError("PLAN_EXPIRED");
    }
  }

  close(): void {
    this.editStore.close();
  }
}
