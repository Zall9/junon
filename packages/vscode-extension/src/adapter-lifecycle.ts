import {
  type AuthenticatedBridgeConnection,
  type BridgeReconnectState,
  type ReconnectingBridgeConnection,
  connectReconnectingBridgeClientFromDiscoveryFile,
  readPrivateDiscoveryFile,
} from "@ide-bridge/bridge-client";
import type {
  AdapterId,
  IDEBPEndpointTopology,
  IdeRegisterRequest,
  IdeRegisterResponse,
} from "@ide-bridge/protocol";

import type { AdapterConfiguration } from "./configuration.js";
import {
  spawnOwnedDaemon,
  type OwnedDaemonProcess,
  type SpawnDaemonOptions,
} from "./daemon-process.js";
import type { SafeLifecycleLogger } from "./safe-logger.js";

export type RegistrationReason = "initial" | "reconnect";
export type RegistrationProvider = (reason: RegistrationReason) => IdeRegisterRequest["params"];
export type AdapterConnectionConfigurator = (
  connection: ReconnectingBridgeConnection,
) => (() => void) | undefined;
export type AdapterRegistrationCompleted = (
  connection: Pick<AuthenticatedBridgeConnection, "notify">,
  reason: RegistrationReason,
  registration: IdeRegisterRequest["params"],
) => void | Promise<void>;

export interface AdapterLifecycleOptions {
  configuration: AdapterConfiguration;
  topology: IDEBPEndpointTopology;
  daemonScriptPath: string;
  registration: RegistrationProvider;
  configureConnection?: AdapterConnectionConfigurator;
  registrationCompleted?: AdapterRegistrationCompleted;
  logger: SafeLifecycleLogger;
  platform?: NodeJS.Platform;
  spawnDaemon?: (options: SpawnDaemonOptions) => OwnedDaemonProcess;
  initialConnectTimeoutMs?: number;
  startupTimeoutMs?: number;
}

const REGISTRATION_TIMEOUT_MS = 5_000;
const DEFAULT_INITIAL_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_RETRY_DELAY_MS = 100;

export class AdapterLifecycle {
  readonly #options: AdapterLifecycleOptions;
  readonly #spawnDaemon: (options: SpawnDaemonOptions) => OwnedDaemonProcess;
  #connection: ReconnectingBridgeConnection | undefined;
  #ownedDaemon: OwnedDaemonProcess | undefined;
  #disposeStateListener: (() => void) | undefined;
  #disposeConfiguredConnection: (() => void) | undefined;
  #startTask: Promise<void> | undefined;
  #stopTask: Promise<void> | undefined;
  #adapterId: AdapterId | undefined;
  #stopping = false;

  constructor(options: AdapterLifecycleOptions) {
    this.#options = options;
    this.#spawnDaemon = options.spawnDaemon ?? spawnOwnedDaemon;
  }

  get isConnected(): boolean {
    return this.#connection?.isConnected === true;
  }

  start(): Promise<void> {
    this.#startTask ??= this.#startInternal();
    return this.#startTask;
  }

  stop(): Promise<void> {
    this.#stopTask ??= this.#stopInternal();
    return this.#stopTask;
  }

  async #startInternal(): Promise<void> {
    try {
      const connection = await this.#connectOrStartDaemon();
      if (this.#stopping) {
        await connection.close();
        return;
      }
      this.#connection = connection;
      const disposeConfiguredConnection = this.#options.configureConnection?.(connection);
      this.#disposeConfiguredConnection =
        typeof disposeConfiguredConnection === "function" ? disposeConfiguredConnection : undefined;
      this.#disposeStateListener = connection.onStateChange((state) => {
        this.#logState(state);
      });
      try {
        const registration = await this.#register(connection, "initial");
        await this.#options.registrationCompleted?.(connection, "initial", registration);
      } catch (error) {
        if (connection.isConnected) throw error;
        await this.#waitForRestoredConnection(connection);
      }
      if (this.#shouldStop()) return;
      this.#options.logger.info("adapter-connected");
    } catch (error) {
      await this.#cleanup();
      throw error;
    }
  }

  async #connectOrStartDaemon(): Promise<ReconnectingBridgeConnection> {
    try {
      return await this.#connect();
    } catch {
      if (!this.#options.configuration.autoStartDaemon) throw new Error("Daemon unavailable");
      await this.#assertAutoStartAllowed();
      this.#ownedDaemon = this.#spawnDaemon({
        scriptPath: this.#options.daemonScriptPath,
        discoveryFile: this.#options.configuration.discoveryFile,
        logLevel: this.#options.configuration.logLevel,
      });
      this.#options.logger.info("daemon-autostarted");
    }

    const deadline = Date.now() + (this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    while (!this.#stopping && Date.now() < deadline) {
      try {
        return await this.#connect();
      } catch {
        await waitForRetry(STARTUP_RETRY_DELAY_MS);
      }
    }
    throw new Error("Daemon startup did not establish an authenticated session");
  }

  async #connect(): Promise<ReconnectingBridgeConnection> {
    return await connectReconnectingBridgeClientFromDiscoveryFile(
      this.#options.configuration.discoveryFile,
      {
        role: "adapter",
        topology: this.#options.topology,
        clientInfo: { name: "ide-bridge-vscode", version: "0.0.0" },
        handshakeTimeoutMs:
          this.#options.initialConnectTimeoutMs ?? DEFAULT_INITIAL_CONNECT_TIMEOUT_MS,
        inboundRequestTimeoutMs: this.#options.configuration.providerTimeoutMs,
        ...(this.#options.configuration.endpointOverride === undefined
          ? {}
          : { endpointOverride: this.#options.configuration.endpointOverride }),
        restoreSession: async (candidate, context) => {
          if (context.signal.aborted || this.#stopping) return;
          const registration = await this.#register(candidate, "reconnect");
          await this.#options.registrationCompleted?.(candidate, "reconnect", registration);
          this.#options.logger.info("registration-restored");
        },
      },
    );
  }

  async #assertAutoStartAllowed(): Promise<void> {
    if (this.#options.configuration.endpointOverride !== undefined) {
      throw new Error("Daemon auto-start is disabled with a manual endpoint");
    }
    if ((this.#options.platform ?? process.platform) === "win32") {
      throw new Error("Daemon auto-start is unavailable on this platform");
    }
    if (
      this.#options.topology.hostKind !== "local" ||
      this.#options.topology.environmentKind !== "local"
    ) {
      throw new Error("Daemon auto-start is not yet available for remote extension hosts");
    }
    try {
      await readPrivateDiscoveryFile(this.#options.configuration.discoveryFile);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw new Error("Existing discovery state is invalid", { cause: error });
      }
    }
  }

  async #register(
    connection: Pick<AuthenticatedBridgeConnection, "request"> | ReconnectingBridgeConnection,
    reason: RegistrationReason,
  ): Promise<IdeRegisterRequest["params"]> {
    const params = this.#options.registration(reason);
    if (this.#adapterId !== undefined && this.#adapterId !== params.adapterId) {
      throw new Error("Adapter identity changed during one logical lifecycle");
    }
    this.#adapterId = params.adapterId;
    const result = await connection.request("ide/register", params, {
      timeoutMs: REGISTRATION_TIMEOUT_MS,
    });
    assertRegistrationResponse(params, result);
    return params;
  }

  async #waitForRestoredConnection(connection: ReconnectingBridgeConnection): Promise<void> {
    if (connection.isConnected) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        dispose();
        if (error === undefined) resolve();
        else reject(error);
      };
      const dispose = connection.onStateChange((state) => {
        if (state.status === "connected") finish();
        if (state.status === "closed") finish(new Error("Connection closed during restoration"));
      });
      const timeout = setTimeout(() => {
        finish(new Error("Adapter session restoration timed out"));
      }, REGISTRATION_TIMEOUT_MS);
      timeout.unref();
      if (connection.isConnected) finish();
    });
  }

  #logState(state: BridgeReconnectState): void {
    if (state.status === "reconnecting") {
      this.#options.logger.warn("adapter-reconnecting");
    }
  }

  #shouldStop(): boolean {
    return this.#stopping;
  }

  async #stopInternal(): Promise<void> {
    this.#stopping = true;
    await this.#startTask?.catch(() => undefined);

    const connection = this.#connection;
    if (connection?.isConnected === true && this.#adapterId !== undefined) {
      await connection
        .request(
          "ide/unregister",
          { adapterId: this.#adapterId },
          { timeoutMs: REGISTRATION_TIMEOUT_MS },
        )
        .catch(() => undefined);
    }
    await this.#cleanup();
    this.#options.logger.info("adapter-stopped");
  }

  async #cleanup(): Promise<void> {
    this.#disposeConfiguredConnection?.();
    this.#disposeConfiguredConnection = undefined;
    this.#disposeStateListener?.();
    this.#disposeStateListener = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close().catch(() => undefined);
    const daemon = this.#ownedDaemon;
    this.#ownedDaemon = undefined;
    await daemon?.stop().catch(() => undefined);
  }
}

function assertRegistrationResponse(
  request: IdeRegisterRequest["params"],
  response: IdeRegisterResponse["result"],
): void {
  const requestedWorkspaceIds = new Set(
    request.workspaces.map((workspace) => workspace.workspaceId),
  );
  if (
    response.adapter.adapterId !== request.adapterId ||
    response.workspaces.length !== requestedWorkspaceIds.size ||
    response.workspaces.some(
      (workspace) =>
        workspace.adapterId !== request.adapterId ||
        !requestedWorkspaceIds.has(workspace.workspaceId),
    )
  ) {
    throw new Error("Daemon registration response is inconsistent");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
