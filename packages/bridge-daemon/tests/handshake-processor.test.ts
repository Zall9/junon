import type { BridgeHandshakeRequest } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import { generateAuthenticationToken } from "../src/security/authentication-token.js";
import { HandshakeProcessor, compareProtocolVersions } from "../src/session/handshake-processor.js";

const expectedToken = generateAuthenticationToken();

function request(
  overrides: Partial<BridgeHandshakeRequest["params"]> = {},
): BridgeHandshakeRequest {
  return {
    jsonrpc: "2.0",
    id: "handshake-1",
    method: "bridge/handshake",
    params: {
      authentication: { method: "token", token: expectedToken },
      role: "consumer",
      protocol: { minimum: "0.1.0", maximum: "0.1.0" },
      topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
      clientInfo: { name: "test-client", version: "1.2.3" },
      ...overrides,
    },
  };
}

function processor() {
  return new HandshakeProcessor({
    expectedToken,
    createSessionId: () => "session_test",
    now: () => new Date("2026-08-01T12:00:00Z"),
  });
}

describe("pre-dispatch handshake processor", () => {
  it.each(["adapter", "consumer"] as const)("creates a bound %s session", (role) => {
    const outcome = processor().process(request({ role }));
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    expect(outcome.response).toMatchObject({
      id: "handshake-1",
      result: { sessionId: "session_test", role, protocolVersion: "0.1.0" },
    });
    expect(outcome.session).toMatchObject({
      sessionId: "session_test",
      role,
      protocolVersion: "0.1.0",
      clientName: "test-client",
      clientVersion: "1.2.3",
      connectedAt: "2026-08-01T12:00:00.000Z",
    });
  });

  it("returns one generic authentication error for absent, malformed, and wrong tokens", () => {
    const candidates: unknown[] = [
      { ...request(), params: { ...request().params, authentication: { method: "token" } } },
      {
        ...request(),
        params: { ...request().params, authentication: { method: "token", token: "short" } },
      },
      request({ authentication: { method: "token", token: generateAuthenticationToken() } }),
    ];

    for (const candidate of candidates) {
      const outcome = processor().process(candidate);
      expect(outcome.accepted).toBe(false);
      if (outcome.accepted) continue;
      expect(outcome.response.error).toMatchObject({
        code: -32001,
        message: "Authentication failed",
        data: { code: "AUTHENTICATION_FAILED", retryable: false },
      });
      expect(JSON.stringify(outcome.response)).not.toContain(expectedToken);
    }
  });

  it("does not hide malformed non-authentication parameters", () => {
    const invalid = request() as unknown as { params: Record<string, unknown> };
    invalid.params["role"] = "administrator";
    invalid.params["authentication"] = {};

    const outcome = processor().process(invalid);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.response.error.data.code).toBe("INVALID_REQUEST");
  });

  it("rejects a notification or another first method without creating a session", () => {
    for (const firstMessage of [
      { jsonrpc: "2.0", method: "bridge/handshake", params: request().params },
      { ...request(), method: "ide/register" },
    ]) {
      const outcome = processor().process(firstMessage);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.response.error.data.code).toBe("INVALID_REQUEST");
    }
  });

  it("rejects an inverted version range as an invalid request", () => {
    const outcome = processor().process(
      request({ protocol: { minimum: "1.0.0", maximum: "0.1.0" } }),
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.response.error.data.code).toBe("INVALID_REQUEST");
  });

  it("selects the highest discrete supported version in the inclusive range", () => {
    const negotiator = new HandshakeProcessor({
      expectedToken,
      supportedProtocolVersions: ["0.1.0", "0.2.0", "1.0.0"],
      createSessionId: () => "session_test",
    });
    const outcome = negotiator.process(
      request({ protocol: { minimum: "0.1.0", maximum: "0.9.0" } }),
    );
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) expect(outcome.session.protocolVersion).toBe("0.2.0");
  });

  it("returns the supported range when no version intersects", () => {
    const outcome = processor().process(
      request({ protocol: { minimum: "2.0.0", maximum: "3.0.0" } }),
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(outcome.response).toMatchObject({
        error: {
          code: -32002,
          data: {
            code: "UNSUPPORTED_PROTOCOL_VERSION",
            supportedProtocol: { minimum: "0.1.0", maximum: "0.1.0" },
          },
        },
      });
    }
  });

  it("compares arbitrary-size semantic-version segments without numeric precision loss", () => {
    expect(compareProtocolVersions("1.99999999999999999999.0", "2.0.0")).toBeLessThan(0);
    expect(compareProtocolVersions("2.0.0", "2.0.0")).toBe(0);
  });
});
