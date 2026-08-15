import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  isIDEBPApplicationMethod,
  isIDEBPNotificationMethod,
  isJSONRPCRequestIdentifier,
  type IDEBPApplicationMethod,
  type IDEBPNotificationMethod,
  type IDEBPSessionRole,
  type JSONRPCRequestIdentifier,
  type SessionId,
} from "@ide-bridge/protocol";

import type { SessionCloseReason } from "../transport/transport.js";

export const DEFAULT_MAX_LOG_ENTRIES_PER_SECOND = 1_000;
export const MAX_LOG_ENTRIES_PER_SECOND = 10_000;

export type StructuredLogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type StructuredLogSink = (jsonLine: string) => void;
export type HandshakeRejectionReason =
  "authentication-failed" | "unsupported-version" | "invalid-request" | "timeout" | "error";

export interface StructuredLogRecord {
  timestamp: string;
  level: Exclude<StructuredLogLevel, "silent">;
  component: "daemon" | "transport" | "session" | "router" | "observability";
  event:
    | "daemon.started"
    | "daemon.stopped"
    | "handshake.rejected"
    | "session.opened"
    | "session.closed"
    | "rpc.message.processed"
    | "observability.events_dropped";
  result: "success" | "rejected" | "processed" | "error" | "dropped";
  requestId?: string;
  sessionId?: SessionId;
  method?: IDEBPApplicationMethod | IDEBPNotificationMethod;
  role?: IDEBPSessionRole;
  reason?: HandshakeRejectionReason | SessionCloseReason;
  durationMs?: number;
  droppedCount?: number;
}

export interface StructuredLoggerOptions {
  minimumLevel?: StructuredLogLevel;
  sink?: StructuredLogSink;
  maxEntriesPerSecond?: number;
  correlationKey?: Uint8Array;
  now?: () => Date;
  monotonicNow?: () => number;
}

export interface RpcLogMetadata {
  sessionId: SessionId;
  requestId?: JSONRPCRequestIdentifier;
  method?: string;
}

const LEVEL_PRIORITY: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};
const SESSION_ID_PATTERN = /^session_[A-Za-z0-9_-]+$/u;
const NOOP_SINK: StructuredLogSink = () => undefined;
const SESSION_ROLES = new Set<unknown>(["adapter", "consumer"]);
const HANDSHAKE_REJECTION_REASONS = new Set<unknown>([
  "authentication-failed",
  "unsupported-version",
  "invalid-request",
  "timeout",
  "error",
]);
const SESSION_CLOSE_REASONS = new Set<unknown>([
  "session-expired",
  "shutdown",
  "transport-lost",
  "error",
]);

export function createStderrJsonLineSink(): StructuredLogSink {
  return (jsonLine) => {
    process.stderr.write(jsonLine);
  };
}

export class StructuredLogger {
  readonly #minimumLevel: StructuredLogLevel;
  readonly #sink: StructuredLogSink;
  readonly #maxEntriesPerSecond: number;
  readonly #correlationKey: Buffer;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  #windowStartedAt: number | undefined;
  #emittedInWindow = 0;
  #droppedInWindow = 0;

  constructor(options: StructuredLoggerOptions = {}) {
    const minimumLevel = options.minimumLevel ?? "info";
    if (!Object.hasOwn(LEVEL_PRIORITY, minimumLevel)) {
      throw new Error("Structured log level is invalid");
    }
    const maxEntriesPerSecond = options.maxEntriesPerSecond ?? DEFAULT_MAX_LOG_ENTRIES_PER_SECOND;
    if (
      !Number.isSafeInteger(maxEntriesPerSecond) ||
      maxEntriesPerSecond < 1 ||
      maxEntriesPerSecond > MAX_LOG_ENTRIES_PER_SECOND
    ) {
      throw new Error(
        `maxEntriesPerSecond must be between 1 and ${String(MAX_LOG_ENTRIES_PER_SECOND)}`,
      );
    }
    const correlationKey = options.correlationKey ?? randomBytes(32);
    if (correlationKey.byteLength < 32 || correlationKey.byteLength > 1_024) {
      throw new Error("Structured log correlation key must contain between 32 and 1024 bytes");
    }
    this.#minimumLevel = minimumLevel;
    this.#sink = options.sink ?? NOOP_SINK;
    this.#maxEntriesPerSecond = maxEntriesPerSecond;
    this.#correlationKey = Buffer.from(correlationKey);
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  beginOperation(): number {
    return this.#safeMonotonicNow();
  }

  daemonStarted(): void {
    this.#emit({
      level: "info",
      component: "daemon",
      event: "daemon.started",
      result: "success",
    });
  }

  daemonStopped(): void {
    this.#emit({
      level: "info",
      component: "daemon",
      event: "daemon.stopped",
      result: "success",
    });
  }

  handshakeRejected(reason: HandshakeRejectionReason): void {
    const safeReason = this.#safeHandshakeRejectionReason(reason);
    if (safeReason === undefined) return;
    this.#emit({
      level: safeReason === "error" ? "error" : "warn",
      component: "transport",
      event: "handshake.rejected",
      result: "rejected",
      reason: safeReason,
    });
  }

  sessionOpened(sessionId: SessionId, role: IDEBPSessionRole): void {
    const safeSessionId = this.#safeSessionId(sessionId);
    const safeRole = this.#safeRole(role);
    if (safeSessionId === undefined || safeRole === undefined) return;
    this.#emit({
      level: "info",
      component: "session",
      event: "session.opened",
      result: "success",
      sessionId: safeSessionId,
      role: safeRole,
    });
  }

  sessionClosed(sessionId: SessionId, role: IDEBPSessionRole, reason: SessionCloseReason): void {
    const safeSessionId = this.#safeSessionId(sessionId);
    const safeRole = this.#safeRole(role);
    const safeReason = this.#safeSessionCloseReason(reason);
    if (safeSessionId === undefined || safeRole === undefined || safeReason === undefined) return;
    this.#emit({
      level: safeReason === "error" ? "error" : safeReason === "shutdown" ? "info" : "warn",
      component: "session",
      event: "session.closed",
      result: safeReason === "error" ? "error" : "success",
      sessionId: safeSessionId,
      role: safeRole,
      reason: safeReason,
    });
  }

  rpcMessageProcessed(
    metadata: RpcLogMetadata,
    startedAt: number,
    result: "processed" | "error",
  ): void {
    const sessionId = this.#safeSessionId(metadata.sessionId);
    if (sessionId === undefined) return;
    const method =
      metadata.method !== undefined &&
      (isIDEBPApplicationMethod(metadata.method) || isIDEBPNotificationMethod(metadata.method))
        ? metadata.method
        : undefined;
    const requestId = isJSONRPCRequestIdentifier(metadata.requestId)
      ? this.#correlateRequestId(metadata.requestId)
      : undefined;
    const finishedAt = this.#safeMonotonicNow();
    const durationMs = Number.isFinite(startedAt)
      ? Math.round(Math.max(0, finishedAt - startedAt) * 1_000) / 1_000
      : 0;
    this.#emit({
      level: result === "error" ? "error" : "info",
      component: "router",
      event: "rpc.message.processed",
      result,
      sessionId,
      ...(requestId === undefined ? {} : { requestId }),
      ...(method === undefined ? {} : { method }),
      durationMs,
    });
  }

  #emit(
    event: Omit<StructuredLogRecord, "timestamp"> & {
      level: Exclude<StructuredLogLevel, "silent">;
    },
  ): void {
    try {
      if (LEVEL_PRIORITY[event.level] < LEVEL_PRIORITY[this.#minimumLevel]) return;
      const monotonicNow = this.#safeMonotonicNow();
      this.#rotateWindow(monotonicNow);
      if (this.#emittedInWindow >= this.#maxEntriesPerSecond) {
        this.#droppedInWindow = Math.min(Number.MAX_SAFE_INTEGER, this.#droppedInWindow + 1);
        return;
      }
      this.#emittedInWindow += 1;
      this.#write(event);
    } catch {
      // Logging is observational and must never affect protocol behavior.
    }
  }

  #rotateWindow(monotonicNow: number): void {
    const windowStartedAt = this.#windowStartedAt;
    if (windowStartedAt === undefined) {
      this.#windowStartedAt = monotonicNow;
      return;
    }
    if (monotonicNow >= windowStartedAt && monotonicNow - windowStartedAt < 1_000) return;
    const droppedCount = this.#droppedInWindow;
    this.#windowStartedAt = monotonicNow;
    this.#emittedInWindow = 0;
    this.#droppedInWindow = 0;
    if (
      droppedCount > 0 &&
      LEVEL_PRIORITY.warn >= LEVEL_PRIORITY[this.#minimumLevel] &&
      this.#emittedInWindow < this.#maxEntriesPerSecond
    ) {
      this.#emittedInWindow += 1;
      this.#write({
        level: "warn",
        component: "observability",
        event: "observability.events_dropped",
        result: "dropped",
        droppedCount,
      });
    }
  }

  #write(event: Omit<StructuredLogRecord, "timestamp">): void {
    try {
      const timestamp = this.#safeNow().toISOString();
      const record: StructuredLogRecord = { timestamp, ...event };
      this.#sink(`${JSON.stringify(record)}\n`);
    } catch {
      // Sink, serialization, and clock failures are deliberately contained.
    }
  }

  #safeNow(): Date {
    try {
      const value = this.#now();
      return Number.isFinite(value.getTime()) ? value : new Date(0);
    } catch {
      return new Date(0);
    }
  }

  #safeMonotonicNow(): number {
    try {
      const value = this.#monotonicNow();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  #safeSessionId(sessionId: unknown): SessionId | undefined {
    return typeof sessionId === "string" &&
      sessionId.length <= 128 &&
      SESSION_ID_PATTERN.test(sessionId)
      ? sessionId
      : undefined;
  }

  #safeRole(role: unknown): IDEBPSessionRole | undefined {
    return SESSION_ROLES.has(role) ? (role as IDEBPSessionRole) : undefined;
  }

  #safeHandshakeRejectionReason(reason: unknown): HandshakeRejectionReason | undefined {
    return HANDSHAKE_REJECTION_REASONS.has(reason)
      ? (reason as HandshakeRejectionReason)
      : undefined;
  }

  #safeSessionCloseReason(reason: unknown): SessionCloseReason | undefined {
    return SESSION_CLOSE_REASONS.has(reason) ? (reason as SessionCloseReason) : undefined;
  }

  #correlateRequestId(requestId: JSONRPCRequestIdentifier): string {
    const digest = createHmac("sha256", this.#correlationKey)
      .update(`${typeof requestId}:${String(requestId)}`)
      .digest("base64url")
      .slice(0, 22);
    return `request_${digest}`;
  }
}
