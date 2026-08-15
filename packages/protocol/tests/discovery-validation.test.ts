import { describe, expect, it } from "vitest";

import { isIDEBPDiscoveryFile, parseIDEBPDiscoveryFile } from "../src/index.js";

const validDiscoveryFile = {
  protocolVersion: "0.1.0",
  endpoint: "ws://127.0.0.1:41731/rpc",
  token: "a".repeat(43),
  pid: 12345,
  startedAt: "2026-08-01T12:00:00Z",
};

describe("discovery runtime validation", () => {
  it("accepts the canonical private loopback contract", () => {
    expect(isIDEBPDiscoveryFile(validDiscoveryFile)).toBe(true);
    expect(parseIDEBPDiscoveryFile(validDiscoveryFile)).toEqual(validDiscoveryFile);
    expect(isIDEBPDiscoveryFile({ ...validDiscoveryFile, endpoint: "ws://[::1]:41731/rpc" })).toBe(
      true,
    );
  });

  it("rejects public endpoints and does not echo secret values", () => {
    const invalid = { ...validDiscoveryFile, endpoint: "ws://0.0.0.0:41731/rpc" };
    expect(isIDEBPDiscoveryFile(invalid)).toBe(false);

    let message = "";
    try {
      parseIDEBPDiscoveryFile(invalid);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Invalid IDEBP discovery file");
    expect(message).not.toContain(validDiscoveryFile.token);
  });

  it("rejects ports outside the TCP range even when the URI schema matches", () => {
    expect(
      isIDEBPDiscoveryFile({ ...validDiscoveryFile, endpoint: "ws://127.0.0.1:99999/rpc" }),
    ).toBe(false);
  });
});
