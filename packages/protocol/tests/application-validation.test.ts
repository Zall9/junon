import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  IDEBP_APPLICATION_METHODS,
  IDEBP_NOTIFICATION_METHODS,
  classifyIDEBPNotification,
  isIDEBPApplicationRequest,
  isIDEBPApplicationResponse,
  isIDEBPJSONRPCErrorResponse,
} from "../src/index.js";

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectMethodConstants(value: unknown, methods = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, methods);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const method = record["method"];
    if (typeof method === "object" && method !== null) {
      const constant = (method as Record<string, unknown>)["const"];
      if (typeof constant === "string") methods.add(constant);
    }
    for (const child of Object.values(record)) collectMethodConstants(child, methods);
  }
  return methods;
}

function readSchema(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("application runtime validation", () => {
  it("keeps the runtime method registries aligned with canonical schema constants", () => {
    const methodDirectory = join(protocolDirectory, "schemas", "method");
    const applicationMethods = new Set<string>();
    for (const file of readdirSync(methodDirectory).filter((name) => name.endsWith(".json"))) {
      collectMethodConstants(readSchema(join(methodDirectory, file)), applicationMethods);
    }
    const eventMethods = collectMethodConstants(
      readSchema(join(protocolDirectory, "schemas", "notification", "events.schema.json")),
    );
    const cancelMethods = collectMethodConstants(
      readSchema(join(protocolDirectory, "schemas", "notification", "cancel-request.schema.json")),
    );

    expect([...IDEBP_APPLICATION_METHODS].sort()).toEqual([...applicationMethods].sort());
    expect(IDEBP_APPLICATION_METHODS).toHaveLength(27);
    expect([...IDEBP_NOTIFICATION_METHODS].sort()).toEqual(
      [...eventMethods, ...cancelMethods].sort(),
    );
    expect(IDEBP_NOTIFICATION_METHODS).toHaveLength(15);
  });

  it("validates a request and its method-specific success response", () => {
    expect(
      isIDEBPApplicationRequest("ide/ping", {
        jsonrpc: "2.0",
        id: "request_ping",
        method: "ide/ping",
        params: { sentAt: "2026-08-01T12:00:00Z" },
      }),
    ).toBe(true);
    expect(
      isIDEBPApplicationResponse("ide/ping", {
        jsonrpc: "2.0",
        id: "request_ping",
        result: {
          sentAt: "2026-08-01T12:00:00Z",
          receivedAt: "2026-08-01T12:00:01Z",
        },
      }),
    ).toBe(true);
    expect(
      isIDEBPApplicationResponse("workspace/list", {
        jsonrpc: "2.0",
        id: "request_ping",
        result: {
          sentAt: "2026-08-01T12:00:00Z",
          receivedAt: "2026-08-01T12:00:01Z",
        },
      }),
    ).toBe(false);
  });

  it("classifies exact notifications and rejects extensions or unknown methods", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "adapter/disconnected",
      params: { adapterId: "adapter_fixture", reason: "transport-lost" },
    };
    expect(classifyIDEBPNotification(notification)).toMatchObject({
      kind: "valid",
      method: "adapter/disconnected",
    });
    expect(classifyIDEBPNotification({ ...notification, extra: true })).toEqual({
      kind: "invalid",
    });
    expect(
      classifyIDEBPNotification({ jsonrpc: "2.0", method: "custom/event", params: {} }),
    ).toEqual({ kind: "unknown" });
  });

  it("validates normalized application error responses", () => {
    expect(
      isIDEBPJSONRPCErrorResponse({
        jsonrpc: "2.0",
        id: "request_error",
        error: {
          code: -32000,
          message: "Request timed out",
          data: { code: "TIMEOUT", retryable: true },
        },
      }),
    ).toBe(true);
  });
});
