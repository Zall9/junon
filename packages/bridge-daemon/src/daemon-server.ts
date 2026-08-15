import { isJSONRPCRequestIdentifier } from "@ide-bridge/protocol";
import type {
  IDEBPProtocolVersion,
  JSONRPCRequestIdentifier,
  SessionId,
} from "@ide-bridge/protocol";

import { DashboardServer } from "./dashboard/dashboard-server.js";
import { StructuredLogger } from "./observability/structured-logger.js";
import { ApplicationRouter, type ApplicationRouterOptions } from "./routing/application-router.js";
import { SessionRegistry } from "./session/session-registry.js";
import { LoopbackWebSocketServer } from "./transport/loopback-websocket-server.js";
import type { ServerTransport } from "./transport/transport.js";

export interface IDEBPDaemonServerOptions extends ApplicationRouterOptions {
  expectedToken: string;
  supportedProtocolVersions?: readonly IDEBPProtocolVersion[];
  createSessionId?: () => SessionId;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  heartbeatIntervalMs?: number;
  maxMissedHeartbeats?: number;
  logger?: StructuredLogger;
}

export class IDEBPDaemonServer implements ServerTransport {
  readonly registry: SessionRegistry;
  readonly router: ApplicationRouter;

  /**
   * The read-only local surface, when it was asked for (ADR-0035).
   *
   * Off unless started: a port nobody asked for is a port nobody is watching. What it serves is assembled
   * here rather than inside it, so the dashboard code knows nothing about the protocol and cannot widen
   * what a reader sees by accident.
   */
  #dashboard: DashboardServer | undefined;
  readonly #transport: LoopbackWebSocketServer;
  readonly #logger: StructuredLogger;
  #running = false;

  constructor(options: IDEBPDaemonServerOptions) {
    this.#logger = options.logger ?? new StructuredLogger({ minimumLevel: "silent" });
    this.registry = new SessionRegistry(options.now === undefined ? {} : { now: options.now });
    this.router = new ApplicationRouter(this.registry, options);
    this.#transport = new LoopbackWebSocketServer({
      expectedToken: options.expectedToken,
      ...(options.supportedProtocolVersions === undefined
        ? {}
        : { supportedProtocolVersions: options.supportedProtocolVersions }),
      ...(options.createSessionId === undefined
        ? {}
        : { createSessionId: options.createSessionId }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxMessageBytes }),
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.maxMissedHeartbeats === undefined
        ? {}
        : { maxMissedHeartbeats: options.maxMissedHeartbeats }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onSessionOpened: (connection) => {
        this.registry.open(connection);
        const session = connection.session;
        this.#logger.sessionOpened(session.sessionId, session.role);
      },
      onSessionActivity: (connection) => {
        this.registry.touch(connection.session.sessionId);
      },
      onSessionClosed: (connection, reason) => {
        this.router.sessionClosed(connection, reason);
        const session = connection.session;
        this.#logger.sessionClosed(session.sessionId, session.role, reason);
      },
      onHandshakeRejected: (reason) => {
        this.#logger.handshakeRejected(reason);
      },
      onAuthenticatedMessage: async (connection, message) => {
        const startedAt = this.#logger.beginOperation();
        const metadata = rpcLogMetadata(connection.session.sessionId, message);
        // Timed here because this is where a request begins and ends; the router sees what the answer
        // was, this sees how long it took (ADR-0035). Counted whether it succeeded or refused — a
        // refusal is a served request, and a panel that dropped them would understate the load.
        const measuredAt = performance.now();
        try {
          await this.router.handle(connection, message);
          this.#logger.rpcMessageProcessed(metadata, startedAt, "processed");
        } catch (error) {
          this.#logger.rpcMessageProcessed(metadata, startedAt, "error");
          throw error;
        } finally {
          if (metadata.method !== undefined) {
            this.router.metrics.recordCall(metadata.method, performance.now() - measuredAt);
          }
        }
      },
    });
  }

  get endpoint(): string | undefined {
    return this.#transport.endpoint;
  }

  /**
   * Starts the dashboard surface and returns the single URL that opens it.
   *
   * Read-only by construction: this hands the surface a function that returns a snapshot, and there is no
   * path from the surface back into the registry, the plan store or an adapter.
   */
  async startDashboard(): Promise<{ endpoint: string; url: string }> {
    const dashboard = new DashboardServer({
      // The same answer `bridge/getStatus` gives, plus the two listings a reader needs to see what is
      // connected. Assembled from the router so the page cannot drift from the wire.
      snapshot: () => ({
        ...this.router.status(),
        adapters: this.registry.listAdapters(),
        workspaces: this.registry.listWorkspaces(),
      }),
    });
    this.#dashboard = dashboard;
    return await dashboard.start();
  }

  get dashboardEndpoint(): string | undefined {
    return this.#dashboard?.endpoint;
  }

  async start(): Promise<string> {
    const endpoint = await this.#transport.start();
    this.#running = true;
    this.#logger.daemonStarted();
    return endpoint;
  }

  sweepSessions(): void {
    this.#transport.sweepSessions();
  }

  async close(): Promise<void> {
    const wasRunning = this.#running;
    try {
      await this.#transport.close();
    } finally {
      this.#running = false;
      await this.#dashboard?.close();
      this.#dashboard = undefined;
      this.router.close();
      if (wasRunning) this.#logger.daemonStopped();
    }
  }
}

function rpcLogMetadata(
  sessionId: SessionId,
  value: unknown,
): {
  sessionId: SessionId;
  requestId?: JSONRPCRequestIdentifier;
  method?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { sessionId };
  const record = value as Record<string, unknown>;
  const requestId = record["id"];
  const method = record["method"];
  return {
    sessionId,
    ...(isJSONRPCRequestIdentifier(requestId) ? { requestId } : {}),
    ...(typeof method === "string" ? { method } : {}),
  };
}
