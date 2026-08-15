import {
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
  IDEBP_ROUTED_METHODS,
} from "@ide-bridge/protocol";
import type {
  IDEBPApplicationMethod,
  IDEBPNotificationMethod,
  IDEBPNotificationParams,
  IDEBPRequestParams,
  IDEBPResponseResult,
  IDEBPRoutedMethod,
} from "@ide-bridge/protocol";

import {
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientReconnectingError,
} from "../errors.js";
import type {
  AuthenticatedBridgeConnection,
  AuthenticatedBridgeSession,
} from "./authenticated-connection.js";
import {
  connectBridgeClientFromDiscoveryFile,
  type ConnectBridgeClientFromDiscoveryFileOptions,
} from "./connect.js";
import type {
  BridgeAdapterRequestContext,
  BridgeAdapterRequestHandler,
  BridgeNotificationHandler,
  BridgeRequestOptions,
} from "./json-rpc-engine.js";

export const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;
export const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 2;
export const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const MAX_RECONNECT_BACKOFF_MULTIPLIER = 10;
export const DEFAULT_SESSION_RESTORE_TIMEOUT_MS = 30_000;
export const MAX_SESSION_RESTORE_TIMEOUT_MS = 300_000;

export interface BridgeSessionRestorationContext {
  attempt: number;
  previousSession: AuthenticatedBridgeSession;
  signal: AbortSignal;
}

export type BridgeSessionRestorer = (
  connection: AuthenticatedBridgeConnection,
  context: BridgeSessionRestorationContext,
) => void | Promise<void>;

export interface BridgeReconnectOptions {
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  reconnectJitterRatio?: number;
  sessionRestoreTimeoutMs?: number;
  restoreSession?: BridgeSessionRestorer;
}

export interface ConnectReconnectingBridgeClientFromDiscoveryFileOptions
  extends Omit<ConnectBridgeClientFromDiscoveryFileOptions, "signal">, BridgeReconnectOptions {}

export type BridgeReconnectState =
  | { status: "connected"; session: AuthenticatedBridgeSession }
  | { status: "reconnecting"; attempt: number; nextDelayMs: number }
  | { status: "closed" };

export type BridgeReconnectStateHandler = (state: BridgeReconnectState) => void | Promise<void>;

interface ReconnectSettings {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  restoreTimeoutMs: number;
}

type UntypedRequestHandler = (
  params: unknown,
  context: BridgeAdapterRequestContext<IDEBPRoutedMethod>,
) => object | Promise<object>;

type UntypedNotificationHandler = (params: unknown) => void | Promise<void>;

interface RequestRegistration {
  handler: UntypedRequestHandler;
  disposers: Map<AuthenticatedBridgeConnection, () => void>;
}

interface NotificationRegistration {
  handler: UntypedNotificationHandler;
  disposers: Map<AuthenticatedBridgeConnection, () => void>;
}

const ROUTED_METHODS = new Set<IDEBPRoutedMethod>(IDEBP_ROUTED_METHODS);
const CONSUMER_NOTIFICATIONS = new Set<IDEBPNotificationMethod>(
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
);

function reconnectSettings(options: BridgeReconnectOptions): ReconnectSettings {
  const initialDelayMs = options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const multiplier = options.reconnectBackoffMultiplier ?? DEFAULT_RECONNECT_BACKOFF_MULTIPLIER;
  const jitterRatio = options.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO;
  const restoreTimeoutMs = options.sessionRestoreTimeoutMs ?? DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(initialDelayMs) ||
    initialDelayMs < 1 ||
    initialDelayMs > MAX_RECONNECT_DELAY_MS ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < initialDelayMs ||
    maxDelayMs > MAX_RECONNECT_DELAY_MS ||
    !Number.isFinite(multiplier) ||
    multiplier < 1 ||
    multiplier > MAX_RECONNECT_BACKOFF_MULTIPLIER ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1 ||
    !Number.isSafeInteger(restoreTimeoutMs) ||
    restoreTimeoutMs < 1 ||
    restoreTimeoutMs > MAX_SESSION_RESTORE_TIMEOUT_MS
  ) {
    throw new BridgeClientConfigurationError("IDEBP reconnect options are invalid");
  }
  return { initialDelayMs, maxDelayMs, multiplier, jitterRatio, restoreTimeoutMs };
}

function connectionOptions(
  options: ConnectReconnectingBridgeClientFromDiscoveryFileOptions,
): ConnectBridgeClientFromDiscoveryFileOptions {
  return {
    role: options.role,
    topology: structuredClone(options.topology),
    ...(options.clientInfo === undefined ? {} : { clientInfo: { ...options.clientInfo } }),
    ...(options.endpointOverride === undefined
      ? {}
      : { endpointOverride: options.endpointOverride }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    ...(options.createRequestId === undefined ? {} : { createRequestId: options.createRequestId }),
    ...(options.inboundRequestTimeoutMs === undefined
      ? {}
      : { inboundRequestTimeoutMs: options.inboundRequestTimeoutMs }),
    ...(options.maxInboundRequests === undefined
      ? {}
      : { maxInboundRequests: options.maxInboundRequests }),
  };
}

export class ReconnectingBridgeConnection {
  readonly #filePath: string;
  readonly #connectOptions: ConnectBridgeClientFromDiscoveryFileOptions;
  readonly #settings: ReconnectSettings;
  readonly #restoreSession: BridgeSessionRestorer | undefined;
  readonly #lifecycle = new AbortController();
  readonly #requestHandlers = new Map<IDEBPRoutedMethod, RequestRegistration>();
  readonly #notificationHandlers = new Map<
    IDEBPNotificationMethod,
    Set<NotificationRegistration>
  >();
  readonly #stateHandlers = new Set<BridgeReconnectStateHandler>();
  #current: AuthenticatedBridgeConnection | undefined;
  #candidate: AuthenticatedBridgeConnection | undefined;
  #restoreController: AbortController | undefined;
  #state: BridgeReconnectState;
  #generation = 1;
  #isClosed = false;
  #resolveClosed: () => void = () => undefined;
  readonly closed: Promise<void>;

  constructor(
    filePath: string,
    options: ConnectReconnectingBridgeClientFromDiscoveryFileOptions,
    initialConnection: AuthenticatedBridgeConnection,
    settings: ReconnectSettings,
  ) {
    this.#filePath = filePath;
    this.#connectOptions = connectionOptions(options);
    this.#settings = settings;
    this.#restoreSession = options.restoreSession;
    this.#current = initialConnection;
    this.#state = { status: "connected", session: initialConnection.session };
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void this.#monitor(initialConnection, this.#generation);
  }

  get state(): BridgeReconnectState {
    return structuredClone(this.#state);
  }

  get session(): AuthenticatedBridgeSession | undefined {
    return this.#current?.isOpen === true ? this.#current.session : undefined;
  }

  get isConnected(): boolean {
    return this.#state.status === "connected" && this.#current?.isOpen === true;
  }

  request<M extends IDEBPApplicationMethod>(
    method: M,
    params: IDEBPRequestParams<M>,
    options?: BridgeRequestOptions,
  ): Promise<IDEBPResponseResult<M>> {
    const connection = this.#usableConnection();
    if (connection instanceof Error) return Promise.reject(connection);
    return connection.request(method, params, options);
  }

  notify<M extends IDEBPNotificationMethod>(
    method: M,
    params: IDEBPNotificationParams<M>,
  ): Promise<void> {
    const connection = this.#usableConnection();
    if (connection instanceof Error) return Promise.reject(connection);
    return connection.notify(method, params);
  }

  onRequest<M extends IDEBPRoutedMethod>(
    method: M,
    handler: BridgeAdapterRequestHandler<M>,
  ): () => void {
    if (this.#connectOptions.role !== "adapter" || !ROUTED_METHODS.has(method)) {
      throw new BridgeClientConfigurationError(
        "Inbound IDEBP request handlers require an adapter session",
      );
    }
    if (this.#requestHandlers.has(method)) {
      throw new BridgeClientConfigurationError("An IDEBP request handler is already registered");
    }
    const registration: RequestRegistration = {
      handler: handler as UntypedRequestHandler,
      disposers: new Map(),
    };
    this.#requestHandlers.set(method, registration);
    this.#attachRequestRegistration(method, registration, this.#current);
    this.#attachRequestRegistration(method, registration, this.#candidate);
    return () => {
      if (this.#requestHandlers.get(method) !== registration) return;
      this.#requestHandlers.delete(method);
      for (const dispose of registration.disposers.values()) dispose();
      registration.disposers.clear();
    };
  }

  onNotification<M extends IDEBPNotificationMethod>(
    method: M,
    handler: BridgeNotificationHandler<M>,
  ): () => void {
    const authorized =
      this.#connectOptions.role === "adapter"
        ? method === "$/cancelRequest"
        : CONSUMER_NOTIFICATIONS.has(method);
    if (!authorized) {
      throw new BridgeClientConfigurationError(
        "IDEBP notification is not received by this session role",
      );
    }
    const registration: NotificationRegistration = {
      handler: handler as UntypedNotificationHandler,
      disposers: new Map(),
    };
    const registrations =
      this.#notificationHandlers.get(method) ?? new Set<NotificationRegistration>();
    registrations.add(registration);
    this.#notificationHandlers.set(method, registrations);
    this.#attachNotificationRegistration(method, registration, this.#current);
    this.#attachNotificationRegistration(method, registration, this.#candidate);
    return () => {
      registrations.delete(registration);
      for (const dispose of registration.disposers.values()) dispose();
      registration.disposers.clear();
      if (registrations.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  onStateChange(handler: BridgeReconnectStateHandler): () => void {
    this.#stateHandlers.add(handler);
    return () => {
      this.#stateHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.#isClosed) {
      await this.closed;
      return;
    }
    this.#isClosed = true;
    this.#lifecycle.abort();
    this.#restoreController?.abort();
    const connections = new Set(
      [this.#current, this.#candidate].filter(
        (connection): connection is AuthenticatedBridgeConnection => connection !== undefined,
      ),
    );
    this.#current = undefined;
    this.#candidate = undefined;
    this.#transition({ status: "closed" });
    for (const connection of connections) this.#detachConnection(connection);
    await Promise.all(
      [...connections].map(async (connection) => {
        await connection.close().catch(() => undefined);
      }),
    );
    this.#resolveClosed();
    await this.closed;
  }

  #usableConnection(): AuthenticatedBridgeConnection | Error {
    if (this.#isClosed) return new BridgeClientConnectionError("IDEBP connection is closed");
    if (this.#current?.isOpen !== true) return new BridgeClientReconnectingError();
    return this.#current;
  }

  async #monitor(connection: AuthenticatedBridgeConnection, generation: number): Promise<void> {
    await connection.closed;
    if (this.#isClosed || this.#current !== connection || this.#generation !== generation) {
      return;
    }
    const previousSession = connection.session;
    this.#detachConnection(connection);
    this.#current = undefined;
    await this.#reconnect(previousSession);
  }

  async #reconnect(previousSession: AuthenticatedBridgeSession): Promise<void> {
    let attempt = 1;
    let baseDelayMs = this.#settings.initialDelayMs;
    while (!this.#isClosed) {
      const nextDelayMs = this.#jitteredDelay(baseDelayMs);
      this.#transition({ status: "reconnecting", attempt, nextDelayMs });
      if (!(await this.#waitForRetry(nextDelayMs))) return;

      let connection: AuthenticatedBridgeConnection | undefined;
      try {
        connection = await connectBridgeClientFromDiscoveryFile(this.#filePath, {
          ...this.#connectOptions,
          signal: this.#lifecycle.signal,
        });
        if (this.#shouldStop()) {
          await connection.close();
          return;
        }
        this.#candidate = connection;
        this.#attachConnection(connection);
        await this.#restore(connection, previousSession, attempt);
        if (this.#shouldStop(connection)) {
          await connection.close().catch(() => undefined);
          return;
        }
        this.#candidate = undefined;
        this.#current = connection;
        this.#generation += 1;
        const generation = this.#generation;
        this.#transition({ status: "connected", session: connection.session });
        void this.#monitor(connection, generation);
        return;
      } catch {
        if (connection !== undefined) {
          this.#detachConnection(connection);
          if (this.#candidate === connection) this.#candidate = undefined;
          await connection.close().catch(() => undefined);
        }
        if (this.#shouldStop()) return;
      }

      attempt += 1;
      baseDelayMs = Math.min(
        this.#settings.maxDelayMs,
        Math.max(baseDelayMs, Math.ceil(baseDelayMs * this.#settings.multiplier)),
      );
    }
  }

  async #restore(
    connection: AuthenticatedBridgeConnection,
    previousSession: AuthenticatedBridgeSession,
    attempt: number,
  ): Promise<void> {
    if (this.#restoreSession === undefined) return;
    const controller = new AbortController();
    this.#restoreController = controller;
    const onLifecycleAbort = (): void => {
      controller.abort();
    };
    this.#lifecycle.signal.addEventListener("abort", onLifecycleAbort, { once: true });
    const timeoutError = new Error("IDEBP session restoration timed out");
    const abortError = new Error("IDEBP session restoration was cancelled");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, this.#settings.restoreTimeoutMs);
      timeout.unref();
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(this.#lifecycle.signal.aborted ? abortError : timeoutError);
        },
        { once: true },
      );
    });
    const task = Promise.resolve().then(
      async () =>
        await this.#restoreSession?.(connection, {
          attempt,
          previousSession: structuredClone(previousSession),
          signal: controller.signal,
        }),
    );
    try {
      await Promise.race([task, interrupted]);
    } catch (error) {
      if (error === timeoutError || error === abortError) {
        await connection.close().catch(() => undefined);
        await task.catch(() => undefined);
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.#lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
      if (this.#restoreController === controller) this.#restoreController = undefined;
    }
  }

  #jitteredDelay(baseDelayMs: number): number {
    const spread = this.#settings.jitterRatio;
    const factor = 1 - spread + Math.random() * spread * 2;
    return Math.max(1, Math.min(this.#settings.maxDelayMs, Math.round(baseDelayMs * factor)));
  }

  async #waitForRetry(delayMs: number): Promise<boolean> {
    if (this.#lifecycle.signal.aborted) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#lifecycle.signal.removeEventListener("abort", onAbort);
        resolve(ready);
      };
      const timeout = setTimeout(() => {
        finish(true);
      }, delayMs);
      timeout.unref();
      const onAbort = (): void => {
        finish(false);
      };
      this.#lifecycle.signal.addEventListener("abort", onAbort, { once: true });
      if (this.#lifecycle.signal.aborted) onAbort();
    });
  }

  #attachConnection(connection: AuthenticatedBridgeConnection): void {
    try {
      for (const [method, registration] of this.#requestHandlers) {
        this.#attachRequestRegistration(method, registration, connection);
      }
      for (const [method, registrations] of this.#notificationHandlers) {
        for (const registration of registrations) {
          this.#attachNotificationRegistration(method, registration, connection);
        }
      }
    } catch (error) {
      this.#detachConnection(connection);
      throw error;
    }
  }

  #attachRequestRegistration(
    method: IDEBPRoutedMethod,
    registration: RequestRegistration,
    connection: AuthenticatedBridgeConnection | undefined,
  ): void {
    if (connection === undefined || registration.disposers.has(connection)) return;
    const dispose = connection.onRequest(
      method,
      registration.handler as BridgeAdapterRequestHandler<typeof method>,
    );
    registration.disposers.set(connection, dispose);
  }

  #attachNotificationRegistration(
    method: IDEBPNotificationMethod,
    registration: NotificationRegistration,
    connection: AuthenticatedBridgeConnection | undefined,
  ): void {
    if (connection === undefined || registration.disposers.has(connection)) return;
    const dispose = connection.onNotification(method, registration.handler);
    registration.disposers.set(connection, dispose);
  }

  #detachConnection(connection: AuthenticatedBridgeConnection): void {
    for (const registration of this.#requestHandlers.values()) {
      registration.disposers.get(connection)?.();
      registration.disposers.delete(connection);
    }
    for (const registrations of this.#notificationHandlers.values()) {
      for (const registration of registrations) {
        registration.disposers.get(connection)?.();
        registration.disposers.delete(connection);
      }
    }
  }

  #shouldStop(connection?: AuthenticatedBridgeConnection): boolean {
    return this.#isClosed || (connection !== undefined && !connection.isOpen);
  }

  #transition(state: BridgeReconnectState): void {
    this.#state = structuredClone(state);
    for (const handler of [...this.#stateHandlers]) {
      void Promise.resolve()
        .then(() => handler(structuredClone(state)))
        .catch(() => undefined);
    }
  }
}

export async function connectReconnectingBridgeClientFromDiscoveryFile(
  filePath: string,
  options: ConnectReconnectingBridgeClientFromDiscoveryFileOptions,
): Promise<ReconnectingBridgeConnection> {
  const settings = reconnectSettings(options);
  const initialConnection = await connectBridgeClientFromDiscoveryFile(
    filePath,
    connectionOptions(options),
  );
  return new ReconnectingBridgeConnection(filePath, options, initialConnection, settings);
}
