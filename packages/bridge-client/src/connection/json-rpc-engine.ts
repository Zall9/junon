import { randomBytes } from "node:crypto";

import {
  IDEBP_ADAPTER_ORIGINATED_METHODS,
  IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
  IDEBP_CONSUMER_LOCAL_METHODS,
  IDEBP_ROUTED_METHODS,
  classifyIDEBPNotification,
  isIDEBPApplicationMethod,
  isIDEBPApplicationRequest,
  isIDEBPApplicationResponse,
  isIDEBPJSONRPCErrorResponse,
  isJSONRPCRequestIdentifier,
} from "@ide-bridge/protocol";
import type {
  IDEBPApplicationMethod,
  IDEBPApplicationRequestByMethod,
  IDEBPJSONRPCErrorResponse,
  IDEBPNotificationMethod,
  IDEBPNotificationParams,
  IDEBPRequestParams,
  IDEBPResponseResult,
  IDEBPRoutedMethod,
  IDEBPSessionRole,
  JSONRPCRequestIdentifier,
  SessionId,
} from "@ide-bridge/protocol";
import { WebSocket, type RawData } from "ws";

import {
  BridgeAdapterRequestError,
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientProtocolViolationError,
  BridgeClientRequestCancelledError,
  BridgeClientRequestTimeoutError,
  BridgeClientRpcError,
} from "../errors.js";

export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CLIENT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_INBOUND_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_INBOUND_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_INBOUND_REQUESTS = 128;
export const MAX_INBOUND_REQUESTS = 1_024;
const LATE_RESPONSE_GRACE_MS = 30_000;
const MAX_LATE_RESPONSE_IDS = 1_024;

export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BridgeInboundRequestOptions {
  inboundRequestTimeoutMs?: number;
  maxInboundRequests?: number;
}

export interface BridgeAdapterRequestContext<M extends IDEBPRoutedMethod> {
  id: JSONRPCRequestIdentifier;
  method: M;
  sessionId: SessionId;
  signal: AbortSignal;
}

export type BridgeAdapterRequestHandler<M extends IDEBPRoutedMethod> = (
  params: IDEBPRequestParams<M>,
  context: BridgeAdapterRequestContext<M>,
) => IDEBPResponseResult<M> | Promise<IDEBPResponseResult<M>>;

export type BridgeNotificationHandler<M extends IDEBPNotificationMethod> = (
  params: IDEBPNotificationParams<M>,
) => void | Promise<void>;

type UntypedNotificationHandler = (params: unknown) => void | Promise<void>;
type UntypedAdapterRequestHandler = (
  params: unknown,
  context: BridgeAdapterRequestContext<IDEBPRoutedMethod>,
) => object | Promise<object>;

interface PendingRequest {
  method: IDEBPApplicationMethod;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface LateResponse {
  method: IDEBPApplicationMethod;
  expiration: ReturnType<typeof setTimeout>;
}

interface InboundRequest {
  method: IDEBPRoutedMethod;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface InboundCompletion {
  expiration: ReturnType<typeof setTimeout>;
}

const ADAPTER_ORIGINATED_METHODS = new Set<IDEBPApplicationMethod>(
  IDEBP_ADAPTER_ORIGINATED_METHODS,
);
const CONSUMER_ORIGINATED_METHODS = new Set<IDEBPApplicationMethod>([
  ...IDEBP_CONSUMER_LOCAL_METHODS,
  ...IDEBP_ROUTED_METHODS,
]);
const ROUTED_METHODS = new Set<IDEBPApplicationMethod>(IDEBP_ROUTED_METHODS);
const ADAPTER_OUTBOUND_NOTIFICATIONS = new Set<IDEBPNotificationMethod>(
  IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
);
const CONSUMER_INBOUND_NOTIFICATIONS = new Set<IDEBPNotificationMethod>(
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTextMessage(data: RawData, isBinary: boolean): unknown {
  if (isBinary) throw new Error("Binary application message");
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data.toString("utf8");
  return JSON.parse(text) as unknown;
}

function serializeCanonicalMessage(
  value: unknown,
  validate: (candidate: unknown) => boolean,
): string {
  try {
    if (!validate(value)) throw new Error("Schema validation failed");
    return JSON.stringify(value);
  } catch {
    throw new BridgeClientConfigurationError("IDEBP message parameters are invalid");
  }
}

export class ClientJsonRpcEngine {
  readonly #socket: WebSocket;
  readonly #role: IDEBPSessionRole;
  readonly #sessionId: SessionId;
  readonly #inboundRequestTimeoutMs: number;
  readonly #maxInboundRequests: number;
  readonly #pending = new Map<JSONRPCRequestIdentifier, PendingRequest>();
  readonly #lateResponses = new Map<JSONRPCRequestIdentifier, LateResponse>();
  readonly #inbound = new Map<JSONRPCRequestIdentifier, InboundRequest>();
  readonly #inboundCompletions = new Map<JSONRPCRequestIdentifier, InboundCompletion>();
  readonly #requestHandlers = new Map<IDEBPRoutedMethod, UntypedAdapterRequestHandler>();
  #runningInboundHandlers = 0;
  readonly #notificationHandlers = new Map<
    IDEBPNotificationMethod,
    Set<UntypedNotificationHandler>
  >();
  readonly closed: Promise<void>;

  constructor(
    socket: WebSocket,
    role: IDEBPSessionRole,
    sessionId: SessionId,
    options: BridgeInboundRequestOptions = {},
  ) {
    this.#socket = socket;
    this.#role = role;
    this.#sessionId = sessionId;
    this.#inboundRequestTimeoutMs =
      options.inboundRequestTimeoutMs ?? DEFAULT_INBOUND_REQUEST_TIMEOUT_MS;
    this.#maxInboundRequests = options.maxInboundRequests ?? DEFAULT_MAX_INBOUND_REQUESTS;
    if (
      !Number.isSafeInteger(this.#inboundRequestTimeoutMs) ||
      this.#inboundRequestTimeoutMs < 1 ||
      this.#inboundRequestTimeoutMs > MAX_INBOUND_REQUEST_TIMEOUT_MS ||
      !Number.isSafeInteger(this.#maxInboundRequests) ||
      this.#maxInboundRequests < 1 ||
      this.#maxInboundRequests > MAX_INBOUND_REQUESTS
    ) {
      throw new BridgeClientConfigurationError("Inbound request limits are invalid");
    }
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.#rejectAll(new BridgeClientConnectionError("IDEBP connection closed"));
        this.#abortAllInbound();
        this.#clearInboundCompletions();
        this.#clearLateResponses();
        resolve();
      });
    });
    socket.on("error", () => {
      this.#failConnection(new BridgeClientConnectionError("IDEBP transport failed"));
    });
    socket.on("message", (data, isBinary) => {
      this.#handleMessage(data, isBinary);
    });
  }

  async request<M extends IDEBPApplicationMethod>(
    method: M,
    params: IDEBPRequestParams<M>,
    options: BridgeRequestOptions = {},
  ): Promise<IDEBPResponseResult<M>> {
    const authorizedMethods =
      this.#role === "adapter" ? ADAPTER_ORIGINATED_METHODS : CONSUMER_ORIGINATED_METHODS;
    if (!authorizedMethods.has(method)) {
      return Promise.reject(
        new BridgeClientConfigurationError("IDEBP method is not authorized for this session role"),
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_CLIENT_REQUEST_TIMEOUT_MS
    ) {
      return Promise.reject(
        new BridgeClientConfigurationError(
          `timeoutMs must be between 1 and ${String(MAX_CLIENT_REQUEST_TIMEOUT_MS)}`,
        ),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new BridgeClientRequestCancelledError(method));
    }
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeClientConnectionError("IDEBP connection is not open"));
    }

    const id = this.#createRequestId();
    const request: unknown = { jsonrpc: "2.0", id, method, params };
    const serialized = serializeCanonicalMessage(request, (candidate) =>
      isIDEBPApplicationRequest(method, candidate),
    );

    return await new Promise<IDEBPResponseResult<M>>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#takePending(id);
        if (pending === undefined) return;
        this.#rememberLateResponse(id, method);
        this.#sendCancellationBestEffort(id);
        pending.reject(new BridgeClientRequestCancelledError(method));
      };
      const timeout = setTimeout(() => {
        const pending = this.#takePending(id);
        if (pending === undefined) return;
        this.#rememberLateResponse(id, method);
        this.#sendCancellationBestEffort(id);
        pending.reject(new BridgeClientRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timeout.unref();
      const pending: PendingRequest = {
        method,
        timeout,
        signal: options.signal,
        onAbort,
        resolve: (result) => {
          resolve(result as IDEBPResponseResult<M>);
        },
        reject,
      };
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }

      this.#socket.send(serialized, (error) => {
        if (error == null || !this.#pending.has(id)) return;
        this.#failConnection(new BridgeClientConnectionError("Could not send IDEBP request"));
      });
    });
  }

  async notify<M extends IDEBPNotificationMethod>(
    method: M,
    params: IDEBPNotificationParams<M>,
  ): Promise<void> {
    const authorized =
      this.#role === "adapter"
        ? ADAPTER_OUTBOUND_NOTIFICATIONS.has(method)
        : method === "$/cancelRequest";
    if (!authorized) {
      return Promise.reject(
        new BridgeClientConfigurationError(
          "IDEBP notification is not authorized for this session role",
        ),
      );
    }
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeClientConnectionError("IDEBP connection is not open"));
    }
    const notification: unknown = { jsonrpc: "2.0", method, params };
    const serialized = serializeCanonicalMessage(notification, (candidate) => {
      const validation = classifyIDEBPNotification(candidate);
      return validation.kind === "valid" && validation.method === method;
    });
    await new Promise<void>((resolve, reject) => {
      this.#socket.send(serialized, (error) => {
        if (error == null) resolve();
        else reject(new BridgeClientConnectionError("Could not send IDEBP notification"));
      });
    });
  }

  onNotification<M extends IDEBPNotificationMethod>(
    method: M,
    handler: BridgeNotificationHandler<M>,
  ): () => void {
    const authorized =
      this.#role === "adapter"
        ? method === "$/cancelRequest"
        : CONSUMER_INBOUND_NOTIFICATIONS.has(method);
    if (!authorized) {
      throw new BridgeClientConfigurationError(
        "IDEBP notification is not received by this session role",
      );
    }
    const untypedHandler = handler as UntypedNotificationHandler;
    const handlers =
      this.#notificationHandlers.get(method) ?? new Set<UntypedNotificationHandler>();
    handlers.add(untypedHandler);
    this.#notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(untypedHandler);
      if (handlers.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  onRequest<M extends IDEBPRoutedMethod>(
    method: M,
    handler: BridgeAdapterRequestHandler<M>,
  ): () => void {
    if (this.#role !== "adapter" || !ROUTED_METHODS.has(method)) {
      throw new BridgeClientConfigurationError(
        "Inbound IDEBP request handlers require an adapter session",
      );
    }
    if (this.#requestHandlers.has(method)) {
      throw new BridgeClientConfigurationError("An IDEBP request handler is already registered");
    }
    const untypedHandler = handler as UntypedAdapterRequestHandler;
    this.#requestHandlers.set(method, untypedHandler);
    return () => {
      if (this.#requestHandlers.get(method) === untypedHandler) {
        this.#requestHandlers.delete(method);
      }
    };
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(1000, "Client closed");
    } else {
      this.#socket.terminate();
    }
    await this.closed;
  }

  #createRequestId(): string {
    let id: string;
    do {
      id = `request_${randomBytes(18).toString("base64url")}`;
    } while (this.#pending.has(id) || this.#lateResponses.has(id));
    return id;
  }

  #handleMessage(data: RawData, isBinary: boolean): void {
    let value: unknown;
    try {
      value = parseTextMessage(data, isBinary);
    } catch {
      this.#protocolViolation();
      return;
    }

    if (isRecord(value) && Object.hasOwn(value, "method")) {
      if (Object.hasOwn(value, "id")) this.#handleIncomingRequest(value);
      else this.#handleIncomingNotification(value);
      return;
    }

    if (!isRecord(value)) {
      this.#protocolViolation();
      return;
    }
    const id = value["id"];
    if (!isJSONRPCRequestIdentifier(id)) {
      this.#protocolViolation();
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      const lateResponse = this.#lateResponses.get(id);
      if (lateResponse === undefined) {
        this.#protocolViolation();
        return;
      }
      if (
        !isIDEBPJSONRPCErrorResponse(value) &&
        !isIDEBPApplicationResponse(lateResponse.method, value)
      ) {
        this.#protocolViolation();
        return;
      }
      this.#forgetLateResponse(id);
      return;
    }

    if (isIDEBPJSONRPCErrorResponse(value)) {
      const settled = this.#takePending(id);
      settled?.reject(new BridgeClientRpcError(value.error.data));
      return;
    }
    if (!isIDEBPApplicationResponse(pending.method, value)) {
      this.#protocolViolation();
      return;
    }
    const settled = this.#takePending(id);
    settled?.resolve(value.result);
  }

  #handleIncomingRequest(value: Record<string, unknown>): void {
    const methodValue = value["method"];
    const id = value["id"];
    if (
      this.#role !== "adapter" ||
      typeof methodValue !== "string" ||
      !isIDEBPApplicationMethod(methodValue) ||
      !ROUTED_METHODS.has(methodValue) ||
      !isJSONRPCRequestIdentifier(id) ||
      !isIDEBPApplicationRequest(methodValue, value) ||
      this.#inbound.has(id) ||
      this.#inboundCompletions.has(id)
    ) {
      this.#protocolViolation();
      return;
    }
    const method = methodValue as IDEBPRoutedMethod;
    const handler = this.#requestHandlers.get(method);
    if (handler === undefined) {
      this.#rememberInboundCompletion(id);
      this.#sendInboundError(id, {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { capability: method },
      });
      return;
    }
    if (this.#runningInboundHandlers >= this.#maxInboundRequests) {
      this.#rememberInboundCompletion(id);
      this.#sendInboundError(id, { code: "PRECONDITION_FAILED", retryable: false });
      return;
    }

    const controller = new AbortController();
    const inbound: InboundRequest = { method, controller, timeout: undefined };
    const timeout = setTimeout(() => {
      const taken = this.#takeInbound(id, inbound);
      if (taken === undefined) return;
      taken.controller.abort();
      this.#rememberInboundCompletion(id);
      this.#sendInboundError(id, { code: "TIMEOUT", retryable: true });
    }, this.#inboundRequestTimeoutMs);
    inbound.timeout = timeout;
    timeout.unref();
    this.#inbound.set(id, inbound);
    this.#runningInboundHandlers += 1;
    const request = value as unknown as IDEBPApplicationRequestByMethod[IDEBPRoutedMethod];
    const context: BridgeAdapterRequestContext<IDEBPRoutedMethod> = {
      id,
      method,
      sessionId: this.#sessionId,
      signal: controller.signal,
    };
    void Promise.resolve()
      .then(async () => await handler(request.params, context))
      .then(
        (result) => {
          const taken = this.#takeInbound(id, inbound);
          if (taken === undefined) return;
          this.#rememberInboundCompletion(id);
          this.#sendInboundSuccess(taken.method, id, result);
        },
        (error: unknown) => {
          const taken = this.#takeInbound(id, inbound);
          if (taken === undefined) return;
          this.#rememberInboundCompletion(id);
          this.#sendInboundError(
            id,
            error instanceof BridgeAdapterRequestError
              ? error.data
              : { code: "PROVIDER_FAILED", retryable: false },
          );
        },
      )
      .finally(() => {
        this.#runningInboundHandlers -= 1;
      });
  }

  #handleIncomingNotification(value: Record<string, unknown>): void {
    const validation = classifyIDEBPNotification(value);
    if (validation.kind !== "valid") {
      this.#protocolViolation();
      return;
    }
    if (this.#role === "adapter") {
      if (validation.method !== "$/cancelRequest") {
        this.#protocolViolation();
        return;
      }
      const id = (validation.notification.params as IDEBPNotificationParams<"$/cancelRequest">).id;
      const inbound = this.#takeInbound(id);
      if (inbound === undefined) {
        if (this.#inboundCompletions.has(id)) {
          this.#forgetInboundCompletion(id);
          return;
        }
        this.#protocolViolation();
        return;
      }
      inbound.controller.abort();
      this.#rememberInboundCompletion(id);
      this.#sendInboundError(id, { code: "CANCELLED", retryable: false });
      this.#dispatchNotification(validation.method, validation.notification.params);
      return;
    }
    if (!CONSUMER_INBOUND_NOTIFICATIONS.has(validation.method)) {
      this.#protocolViolation();
      return;
    }
    this.#dispatchNotification(validation.method, validation.notification.params);
  }

  #dispatchNotification(method: IDEBPNotificationMethod, params: unknown): void {
    const handlers = this.#notificationHandlers.get(method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      void Promise.resolve(handler(params)).catch(() => undefined);
    }
  }

  #sendInboundSuccess(
    method: IDEBPRoutedMethod,
    id: JSONRPCRequestIdentifier,
    result: unknown,
  ): void {
    const response: unknown = { jsonrpc: "2.0", id, result };
    if (!isIDEBPApplicationResponse(method, response)) {
      this.#sendInboundError(id, { code: "PROVIDER_FAILED", retryable: false });
      return;
    }
    this.#sendInboundMessage(response);
  }

  #sendInboundError(
    id: JSONRPCRequestIdentifier,
    data: IDEBPJSONRPCErrorResponse["error"]["data"],
  ): void {
    let response: unknown = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32_000,
        message: "IDEBP adapter request failed",
        data: structuredClone(data),
      },
    };
    if (!isIDEBPJSONRPCErrorResponse(response)) {
      response = {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_000,
          message: "IDEBP adapter request failed",
          data: { code: "PROVIDER_FAILED", retryable: false },
        },
      };
    }
    this.#sendInboundMessage(response);
  }

  #sendInboundMessage(value: unknown): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(value), (error) => {
      if (error != null) {
        this.#failConnection(new BridgeClientConnectionError("Could not send IDEBP response"));
      }
    });
  }

  #takePending(id: JSONRPCRequestIdentifier): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  #takeInbound(
    id: JSONRPCRequestIdentifier,
    expected?: InboundRequest,
  ): InboundRequest | undefined {
    const inbound = this.#inbound.get(id);
    if (inbound === undefined || (expected !== undefined && inbound !== expected)) return undefined;
    this.#inbound.delete(id);
    if (inbound.timeout !== undefined) clearTimeout(inbound.timeout);
    return inbound;
  }

  #abortAllInbound(): void {
    for (const id of [...this.#inbound.keys()]) {
      this.#takeInbound(id)?.controller.abort();
    }
  }

  #rememberInboundCompletion(id: JSONRPCRequestIdentifier): void {
    if (this.#inboundCompletions.size >= MAX_LATE_RESPONSE_IDS) {
      const oldestId = this.#inboundCompletions.keys().next().value;
      if (oldestId !== undefined) this.#forgetInboundCompletion(oldestId);
    }
    const expiration = setTimeout(() => {
      this.#inboundCompletions.delete(id);
    }, LATE_RESPONSE_GRACE_MS);
    expiration.unref();
    this.#inboundCompletions.set(id, { expiration });
  }

  #forgetInboundCompletion(id: JSONRPCRequestIdentifier): void {
    const completion = this.#inboundCompletions.get(id);
    if (completion === undefined) return;
    clearTimeout(completion.expiration);
    this.#inboundCompletions.delete(id);
  }

  #clearInboundCompletions(): void {
    for (const { expiration } of this.#inboundCompletions.values()) clearTimeout(expiration);
    this.#inboundCompletions.clear();
  }

  #sendCancellationBestEffort(id: JSONRPCRequestIdentifier): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    const notification = { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } };
    const validation = classifyIDEBPNotification(notification);
    if (validation.kind !== "valid") return;
    try {
      this.#socket.send(JSON.stringify(notification), () => undefined);
    } catch {
      // The original request has already settled locally; transport close handles remaining work.
    }
  }

  #rememberLateResponse(id: JSONRPCRequestIdentifier, method: IDEBPApplicationMethod): void {
    if (this.#lateResponses.size >= MAX_LATE_RESPONSE_IDS) {
      const oldestId = this.#lateResponses.keys().next().value;
      if (oldestId !== undefined) this.#forgetLateResponse(oldestId);
    }
    const expiration = setTimeout(() => {
      this.#lateResponses.delete(id);
    }, LATE_RESPONSE_GRACE_MS);
    expiration.unref();
    this.#lateResponses.set(id, { method, expiration });
  }

  #forgetLateResponse(id: JSONRPCRequestIdentifier): void {
    const lateResponse = this.#lateResponses.get(id);
    if (lateResponse === undefined) return;
    clearTimeout(lateResponse.expiration);
    this.#lateResponses.delete(id);
  }

  #clearLateResponses(): void {
    for (const { expiration } of this.#lateResponses.values()) clearTimeout(expiration);
    this.#lateResponses.clear();
  }

  #protocolViolation(): void {
    const error = new BridgeClientProtocolViolationError(
      "Daemon sent an invalid IDEBP application message",
    );
    this.#rejectAll(error);
    this.#abortAllInbound();
    this.#clearInboundCompletions();
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(1002, "Invalid IDEBP application message");
    } else if (this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.terminate();
    }
  }

  #failConnection(error: BridgeClientConnectionError): void {
    this.#rejectAll(error);
    this.#abortAllInbound();
    this.#clearInboundCompletions();
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#takePending(id)?.reject(error);
    }
  }
}
