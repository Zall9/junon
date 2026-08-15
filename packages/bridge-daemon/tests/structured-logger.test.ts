import { describe, expect, it } from "vitest";

import {
  MAX_LOG_ENTRIES_PER_SECOND,
  StructuredLogger,
  type HandshakeRejectionReason,
  type StructuredLogRecord,
} from "../src/observability/structured-logger.js";
import type { IDEBPSessionRole } from "@ide-bridge/protocol";
import type { SessionCloseReason } from "../src/transport/transport.js";

function parseLines(lines: string[]): StructuredLogRecord[] {
  return lines.map((line) => JSON.parse(line) as StructuredLogRecord);
}

describe("StructuredLogger", () => {
  it("emits an allowlisted JSON record with a pseudonymized request identifier", () => {
    const lines: string[] = [];
    let monotonic = 10;
    const logger = new StructuredLogger({
      sink: (line) => lines.push(line),
      correlationKey: new Uint8Array(32).fill(7),
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      monotonicNow: () => monotonic,
    });
    const secret = "authentication-token-shaped-request-id";
    const startedAt = logger.beginOperation();
    monotonic = 12.3456;
    logger.rpcMessageProcessed(
      {
        sessionId: "session_safe_1",
        requestId: secret,
        method: "document/read",
        ...({
          sourceText: `source-${secret}`,
          replacementText: `replacement-${secret}`,
          diagnostics: [{ message: `diagnostic-${secret}` }],
          error: new Error(`provider-${secret}`),
        } as object),
      },
      startedAt,
      "processed",
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(parseLines(lines)).toEqual([
      {
        timestamp: "2026-08-01T12:00:00.000Z",
        level: "info",
        component: "router",
        event: "rpc.message.processed",
        result: "processed",
        sessionId: "session_safe_1",
        requestId: expect.stringMatching(/^request_[A-Za-z0-9_-]{22}$/u),
        method: "document/read",
        durationMs: 2.346,
      },
    ]);
    expect(Object.keys(parseLines(lines)[0] ?? {}).sort()).toEqual(
      [
        "component",
        "durationMs",
        "event",
        "level",
        "method",
        "requestId",
        "result",
        "sessionId",
        "timestamp",
      ].sort(),
    );
  });

  it("correlates within one process key without allowing cross-key correlation", () => {
    const firstLines: string[] = [];
    const secondLines: string[] = [];
    const first = new StructuredLogger({
      sink: (line) => firstLines.push(line),
      correlationKey: new Uint8Array(32).fill(1),
      monotonicNow: () => 0,
    });
    const second = new StructuredLogger({
      sink: (line) => secondLines.push(line),
      correlationKey: new Uint8Array(32).fill(2),
      monotonicNow: () => 0,
    });
    const metadata = { sessionId: "session_safe_1", requestId: "same-id" } as const;
    first.rpcMessageProcessed(metadata, 0, "processed");
    first.rpcMessageProcessed(metadata, 0, "processed");
    second.rpcMessageProcessed(metadata, 0, "processed");

    const firstRecords = parseLines(firstLines);
    const secondRecords = parseLines(secondLines);
    expect(firstRecords[0]?.requestId).toBe(firstRecords[1]?.requestId);
    expect(firstRecords[0]?.requestId).not.toBe(secondRecords[0]?.requestId);
  });

  it("omits invalid runtime enum values and non-scalar request identifiers", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
    logger.handshakeRejected("rejection-secret" as HandshakeRejectionReason);
    logger.sessionOpened("session_safe_1", "role-secret" as IDEBPSessionRole);
    logger.sessionClosed("session_safe_1", "consumer", "close-secret" as SessionCloseReason);
    logger.rpcMessageProcessed(
      {
        sessionId: "session_safe_1",
        requestId: { toString: () => "identifier-secret" } as never,
        method: "method-secret",
      },
      0,
      "processed",
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(
      /rejection-secret|role-secret|close-secret|identifier-secret|method-secret/u,
    );
    expect(parseLines(lines)[0]).not.toHaveProperty("requestId");
    expect(parseLines(lines)[0]).not.toHaveProperty("method");
  });

  it("bounds emission and summarizes dropped records in the next window", () => {
    const lines: string[] = [];
    let monotonic = 0;
    const logger = new StructuredLogger({
      sink: (line) => lines.push(line),
      maxEntriesPerSecond: 2,
      monotonicNow: () => monotonic,
    });
    logger.daemonStarted();
    logger.sessionOpened("session_safe_1", "consumer");
    logger.handshakeRejected("invalid-request");
    monotonic = 1_001;
    logger.sessionClosed("session_safe_1", "consumer", "shutdown");

    expect(parseLines(lines).map(({ event }) => event)).toEqual([
      "daemon.started",
      "session.opened",
      "observability.events_dropped",
      "session.closed",
    ]);
    expect(parseLines(lines)[2]).toMatchObject({ droppedCount: 1, result: "dropped" });
  });

  it("contains sink and clock failures and filters below the configured level", () => {
    const logger = new StructuredLogger({
      minimumLevel: "error",
      sink: () => {
        throw new Error("sink-secret");
      },
      now: () => {
        throw new Error("clock-secret");
      },
      monotonicNow: () => {
        throw new Error("monotonic-secret");
      },
    });

    expect(() => logger.daemonStarted()).not.toThrow();
    expect(() => logger.handshakeRejected("authentication-failed")).not.toThrow();
    expect(() => logger.handshakeRejected("error")).not.toThrow();
    expect(() => logger.sessionClosed("session_safe_1", "adapter", "error")).not.toThrow();
  });

  it("rejects unsafe logger configuration", () => {
    expect(() => new StructuredLogger({ minimumLevel: "verbose" as "info" })).toThrow(
      "Structured log level is invalid",
    );
    expect(() => new StructuredLogger({ maxEntriesPerSecond: 0 })).toThrow("maxEntriesPerSecond");
    expect(
      () => new StructuredLogger({ maxEntriesPerSecond: MAX_LOG_ENTRIES_PER_SECOND + 1 }),
    ).toThrow("maxEntriesPerSecond");
    expect(() => new StructuredLogger({ correlationKey: new Uint8Array(31) })).toThrow(
      "correlation key",
    );
  });
});
