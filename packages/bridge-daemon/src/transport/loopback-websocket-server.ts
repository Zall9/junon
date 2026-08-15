import type { AddressInfo } from "node:net";

import type { BridgeHandshakeErrorResponse } from "@ide-bridge/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  HandshakeProcessor,
  createInvalidHandshakeRequestResponse,
  type AuthenticatedSession,
  type HandshakeProcessorOptions,
} from "../session/handshake-processor.js";
import type { HandshakeRejectionReason } from "../observability/structured-logger.js";
import type {
  AuthenticatedTransportConnection,
  ServerTransport,
  SessionCloseReason,
} from "./transport.js";

export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_MISSED_HEARTBEATS = 3;
export const MAX_MISSED_HEARTBEATS = 10;

export interface LoopbackWebSocketServerOptions extends HandshakeProcessorOptions {
  maxMessageBytes?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxMissedHeartbeats?: number;
  onAuthenticatedMessage: (
    connection: AuthenticatedTransportConnection,
    message: unknown,
  ) => void | Promise<void>;
  onSessionOpened?: (connection: AuthenticatedTransportConnection) => void;
  onSessionActivity?: (connection: AuthenticatedTransportConnection) => void;
  onSessionClosed?: (
    connection: AuthenticatedTransportConnection,
    reason: SessionCloseReason,
  ) => void;
  onHandshakeRejected?: (reason: HandshakeRejectionReason) => void;
}

type ConnectionState =
  | { kind: "awaiting-handshake" }
  | { kind: "sending-handshake" }
  | { kind: "authenticated"; connection: AuthenticatedTransportConnection }
  | { kind: "closing" };

interface SessionSocketRecord {
  connection: AuthenticatedTransportConnection;
  outstandingHeartbeats: number;
  closeReason: SessionCloseReason;
}

function parseTextMessage(data: RawData, isBinary: boolean): unknown {
  if (isBinary) throw new Error("Binary messages are not valid IDEBP messages");
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data.toString("utf8");
  return JSON.parse(text) as unknown;
}

function sendJson(socket: WebSocket, value: unknown, callback: (error?: Error) => void): void {
  socket.send(JSON.stringify(value), (error) => {
    callback(error ?? undefined);
  });
}

function sendFailureAndClose(socket: WebSocket, response: BridgeHandshakeErrorResponse): void {
  sendJson(socket, response, (error) => {
    if (error !== undefined) socket.terminate();
    else socket.close(1008, "Handshake rejected");
  });
}

class WebSocketTransportConnection implements AuthenticatedTransportConnection {
  readonly #socket: WebSocket;
  readonly #session: AuthenticatedSession;
  readonly #onCloseRequested: (code: number) => void;

  constructor(
    socket: WebSocket,
    session: AuthenticatedSession,
    onCloseRequested: (code: number) => void,
  ) {
    this.#socket = socket;
    this.#session = session;
    this.#onCloseRequested = onCloseRequested;
  }

  get session(): AuthenticatedSession {
    return structuredClone(this.#session);
  }

  async send(message: unknown): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Transport connection is not open");
    }
    await new Promise<void>((resolve, reject) => {
      sendJson(this.#socket, message, (error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  close(code = 1000, reason = "Connection closed"): void {
    this.#onCloseRequested(code);
    this.#socket.close(code, reason);
  }
}

export class LoopbackWebSocketServer implements ServerTransport {
  readonly #options: LoopbackWebSocketServerOptions;
  readonly #processor: HandshakeProcessor;
  readonly #heartbeatIntervalMs: number;
  readonly #maxMissedHeartbeats: number;
  readonly #sessions = new Map<WebSocket, SessionSocketRecord>();
  #server: WebSocketServer | undefined;
  #endpoint: string | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: LoopbackWebSocketServerOptions) {
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (
      !Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < 1 ||
      maxMessageBytes > DEFAULT_MAX_MESSAGE_BYTES
    ) {
      throw new Error(`maxMessageBytes must be between 1 and ${String(DEFAULT_MAX_MESSAGE_BYTES)}`);
    }
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(handshakeTimeoutMs) ||
      handshakeTimeoutMs < 1 ||
      handshakeTimeoutMs > DEFAULT_HANDSHAKE_TIMEOUT_MS
    ) {
      throw new Error(
        `handshakeTimeoutMs must be between 1 and ${String(DEFAULT_HANDSHAKE_TIMEOUT_MS)}`,
      );
    }
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const maxMissedHeartbeats = options.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
      heartbeatIntervalMs > MAX_HEARTBEAT_INTERVAL_MS ||
      !Number.isSafeInteger(maxMissedHeartbeats) ||
      maxMissedHeartbeats < 1 ||
      maxMissedHeartbeats > MAX_MISSED_HEARTBEATS
    ) {
      throw new Error("Heartbeat limits are invalid");
    }
    this.#options = {
      ...options,
      maxMessageBytes,
      handshakeTimeoutMs,
      heartbeatIntervalMs,
      maxMissedHeartbeats,
    };
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#maxMissedHeartbeats = maxMissedHeartbeats;
    this.#processor = new HandshakeProcessor(options);
  }

  get endpoint(): string | undefined {
    return this.#endpoint;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get sessions(): readonly AuthenticatedSession[] {
    return [...this.#sessions.values()].map(({ connection }) => connection.session);
  }

  async start(): Promise<string> {
    if (this.#server !== undefined) throw new Error("Loopback WebSocket server is already started");

    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/rpc",
      maxPayload: this.#options.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.#server = server;
    server.on("connection", (socket, request) => {
      const remoteAddress = request.socket.remoteAddress;
      if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
        socket.terminate();
        return;
      }
      this.#handleConnection(socket);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }

    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("Loopback WebSocket server did not expose a TCP address");
    }
    this.#endpoint = `ws://127.0.0.1:${String(address.port)}/rpc`;
    this.#heartbeatTimer = setInterval(() => {
      this.sweepSessions();
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
    return this.#endpoint;
  }

  sweepSessions(): void {
    for (const [socket, record] of this.#sessions) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (record.outstandingHeartbeats >= this.#maxMissedHeartbeats) {
        record.closeReason = "session-expired";
        socket.close(1001, "Session expired");
        continue;
      }
      record.outstandingHeartbeats += 1;
      try {
        socket.ping();
      } catch {
        record.closeReason = "error";
        socket.terminate();
      }
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    this.#endpoint = undefined;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    for (const [socket, record] of this.#sessions) {
      record.closeReason = "shutdown";
      socket.terminate();
    }
    for (const socket of server.clients) {
      if (!this.#sessions.has(socket)) socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #handleConnection(socket: WebSocket): void {
    let state: ConnectionState = { kind: "awaiting-handshake" };
    let authenticatedConnection: AuthenticatedTransportConnection | undefined;
    let sessionRecord: SessionSocketRecord | undefined;
    const handshakeTimeout = setTimeout(() => {
      if (state.kind === "awaiting-handshake" || state.kind === "sending-handshake") {
        state = { kind: "closing" };
        this.#reportHandshakeRejection("timeout");
        socket.close(1008, "Handshake timeout");
      }
    }, this.#options.handshakeTimeoutMs);
    handshakeTimeout.unref();
    socket.on("error", () => {
      if (sessionRecord !== undefined) sessionRecord.closeReason = "error";
    });
    socket.on("close", (code) => {
      clearTimeout(handshakeTimeout);
      this.#sessions.delete(socket);
      state = { kind: "closing" };
      if (authenticatedConnection !== undefined && sessionRecord !== undefined) {
        if (sessionRecord.closeReason === "transport-lost" && code === 1000) {
          sessionRecord.closeReason = "shutdown";
        }
        try {
          this.#options.onSessionClosed?.(authenticatedConnection, sessionRecord.closeReason);
        } catch {
          // The transport is already closed; lifecycle cleanup is contained by the owner.
        }
        authenticatedConnection = undefined;
        sessionRecord = undefined;
      }
    });
    socket.on("pong", () => {
      if (sessionRecord !== undefined) this.#recordActivity(sessionRecord, socket);
    });
    socket.on("message", (data, isBinary) => {
      if (state.kind === "closing") return;
      if (state.kind === "sending-handshake") {
        state = { kind: "closing" };
        this.#reportHandshakeRejection("invalid-request");
        socket.close(1008, "Handshake response is pending");
        return;
      }

      let value: unknown;
      try {
        value = parseTextMessage(data, isBinary);
      } catch {
        if (state.kind === "awaiting-handshake") {
          state = { kind: "closing" };
          this.#reportHandshakeRejection("invalid-request");
          sendFailureAndClose(socket, createInvalidHandshakeRequestResponse(null));
        } else {
          sendJson(socket, createInvalidHandshakeRequestResponse(null), () => undefined);
        }
        return;
      }

      if (state.kind === "authenticated") {
        if (sessionRecord === undefined || !this.#recordActivity(sessionRecord, socket)) return;
        if (
          typeof value === "object" &&
          value !== null &&
          "method" in value &&
          value.method === "bridge/handshake"
        ) {
          sendJson(socket, createInvalidHandshakeRequestResponse(value), () => undefined);
          return;
        }
        let dispatch: void | Promise<void>;
        try {
          dispatch = this.#options.onAuthenticatedMessage(state.connection, value);
        } catch {
          sessionRecord.closeReason = "error";
          state = { kind: "closing" };
          socket.close(1011, "Message dispatcher failed");
          return;
        }
        void Promise.resolve(dispatch).catch(() => {
          if (sessionRecord !== undefined) sessionRecord.closeReason = "error";
          state = { kind: "closing" };
          socket.close(1011, "Message dispatcher failed");
        });
        return;
      }

      state = { kind: "sending-handshake" };
      let outcome: ReturnType<HandshakeProcessor["process"]>;
      try {
        outcome = this.#processor.process(value);
      } catch {
        state = { kind: "closing" };
        this.#reportHandshakeRejection("error");
        socket.close(1011, "Handshake processing failed");
        return;
      }
      if (!outcome.accepted) {
        state = { kind: "closing" };
        const code = outcome.response.error.data.code;
        this.#reportHandshakeRejection(
          code === "AUTHENTICATION_FAILED"
            ? "authentication-failed"
            : code === "UNSUPPORTED_PROTOCOL_VERSION"
              ? "unsupported-version"
              : "invalid-request",
        );
        sendFailureAndClose(socket, outcome.response);
        return;
      }

      sendJson(socket, outcome.response, (error) => {
        if (
          error !== undefined ||
          state.kind !== "sending-handshake" ||
          socket.readyState !== WebSocket.OPEN
        ) {
          state = { kind: "closing" };
          socket.terminate();
          return;
        }
        clearTimeout(handshakeTimeout);
        const connection = new WebSocketTransportConnection(socket, outcome.session, (code) => {
          if (sessionRecord !== undefined) {
            sessionRecord.closeReason = code === 1000 ? "shutdown" : "error";
          }
        });
        try {
          this.#options.onSessionOpened?.(connection);
        } catch {
          state = { kind: "closing" };
          socket.close(1011, "Session initialization failed");
          return;
        }
        authenticatedConnection = connection;
        sessionRecord = {
          connection,
          outstandingHeartbeats: 0,
          closeReason: "transport-lost",
        };
        state = { kind: "authenticated", connection };
        this.#sessions.set(socket, sessionRecord);
      });
    });
  }

  #recordActivity(record: SessionSocketRecord, socket: WebSocket): boolean {
    record.outstandingHeartbeats = 0;
    try {
      this.#options.onSessionActivity?.(record.connection);
      return true;
    } catch {
      record.closeReason = "error";
      socket.close(1011, "Session activity failed");
      return false;
    }
  }

  #reportHandshakeRejection(reason: HandshakeRejectionReason): void {
    try {
      this.#options.onHandshakeRejected?.(reason);
    } catch {
      // Observability callbacks cannot influence the handshake state machine.
    }
  }
}
