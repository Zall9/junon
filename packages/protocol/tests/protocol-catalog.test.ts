import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  IDEBP_ADAPTER_ORIGINATED_METHODS,
  IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
  IDEBP_APPLICATION_METHODS,
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
  IDEBP_CONSUMER_LOCAL_METHODS,
  IDEBP_ROUTED_METHODS,
} from "../src/index.js";

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(protocolDirectory, "schemas");

const expectedRequests = [
  "bridge/handshake",
  "ide/register",
  "ide/unregister",
  "ide/ping",
  "ide/getCapabilities",
  "workspace/list",
  "workspace/get",
  "workspace/getStatus",
  "document/read",
  "document/getRevision",
  "document/getSymbols",
  "workspace/searchSymbols",
  "workspace/searchTodos",
  "workspace/listBookmarks",
  "symbol/resolveAt",
  "symbol/getDefinition",
  "symbol/getReferences",
  "symbol/getImplementations",
  "symbol/getHierarchy",
  "diagnostics/getSnapshot",
  "refactor/prepare",
  "refactor/prepareRename",
  "workspace/applyPlan",
  "workspace/discardPlan",
  "workspace/undo",
  "bridge/getStatus",
  "bridge/listAdapters",
  "bridge/listSessions",
] as const;

const expectedNotifications = [
  "$/cancelRequest",
  "adapter/capabilitiesChanged",
  "adapter/disconnected",
  "workspace/opened",
  "workspace/closed",
  "workspace/rootsChanged",
  "workspace/readinessChanged",
  "workspace/trustChanged",
  "document/opened",
  "document/changed",
  "document/saved",
  "document/closed",
  "document/renamed",
  "document/deleted",
  "diagnostics/changed",
] as const;

const expectedErrors = [
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "AUTHENTICATION_FAILED",
  "WORKSPACE_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "ADAPTER_NOT_FOUND",
  "ADAPTER_DISCONNECTED",
  "CAPABILITY_UNAVAILABLE",
  "INDEX_NOT_READY",
  "STALE_DOCUMENT",
  "STALE_SYMBOL",
  "AMBIGUOUS_SYMBOL",
  "INVALID_IDENTIFIER",
  "PRECONDITION_FAILED",
  "PLAN_NOT_FOUND",
  "PLAN_EXPIRED",
  "PROVIDER_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "PERMISSION_DENIED",
  "PARTIAL_APPLY",
  "INTERNAL_ERROR",
] as const;

function listJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectMethodConstants(value: any, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, output);
    return output;
  }
  if (typeof value !== "object" || value === null) return output;

  if (typeof value.method?.const === "string") output.add(value.method.const);
  for (const child of Object.values(value)) collectMethodConstants(child, output);
  return output;
}

describe("IDEBP public contract catalog", () => {
  it("exposes canonical wire schemas for Phase 2 runtime validation", () => {
    const packageManifest = readJson(join(protocolDirectory, "package.json"));
    expect(packageManifest.files).toContain("schemas");
    expect(packageManifest.exports["./schemas/*"]).toBe("./schemas/*");
  });

  it("defines every MVP request method exactly once in the request schema set", () => {
    const requestFiles = [
      join(schemasDirectory, "bridge", "handshake-request.schema.json"),
      ...listJsonFiles(join(schemasDirectory, "method")),
    ];
    const methods = new Set<string>();
    for (const path of requestFiles) collectMethodConstants(readJson(path), methods);

    expect([...methods].sort()).toEqual([...expectedRequests].sort());
  });

  it("defines every MVP and cancellation notification", () => {
    const methods = new Set<string>();
    for (const path of listJsonFiles(join(schemasDirectory, "notification"))) {
      collectMethodConstants(readJson(path), methods);
    }

    expect([...methods].sort()).toEqual([...expectedNotifications].sort());
  });

  it("defines a response schema for the handshake and every MVP method", () => {
    let responseCount = 1;
    for (const path of listJsonFiles(join(schemasDirectory, "method"))) {
      const definitions = readJson(path).$defs ?? {};
      responseCount += Object.keys(definitions).filter((name) => name.endsWith("Response")).length;
    }

    expect(responseCount).toBe(expectedRequests.length);
  });

  it("defines every normalized IDEBP error code", () => {
    const errorSchema = readJson(join(schemasDirectory, "error", "error-response.schema.json"));
    expect(errorSchema.$defs.errorCode.enum).toEqual(expectedErrors);
  });

  it("partitions request and notification authority without drift", () => {
    const requestPartitions = [
      ...IDEBP_ADAPTER_ORIGINATED_METHODS,
      ...IDEBP_CONSUMER_LOCAL_METHODS,
      ...IDEBP_ROUTED_METHODS,
    ];
    expect(new Set(requestPartitions).size).toBe(requestPartitions.length);
    expect([...requestPartitions].sort()).toEqual([...IDEBP_APPLICATION_METHODS].sort());

    expect(IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS).toEqual([
      ...IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
      "adapter/disconnected",
    ]);
    expect(IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS).not.toContain("$/cancelRequest");
    expect(IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS).not.toContain("adapter/disconnected");
    for (const partition of [
      IDEBP_ADAPTER_ORIGINATED_METHODS,
      IDEBP_CONSUMER_LOCAL_METHODS,
      IDEBP_ROUTED_METHODS,
      IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
      IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
    ]) {
      expect(Object.isFrozen(partition)).toBe(true);
    }
  });
});
