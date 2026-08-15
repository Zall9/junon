import { describe, expect, it } from "vitest";

import {
  classifyBridgeHandshakeServerMessage,
  classifyBridgeHandshakeRequest,
  isBridgeHandshakeErrorResponse,
  isBridgeHandshakeRequest,
  isBridgeHandshakeResponse,
  isJSONRPCRequestIdentifier,
} from "../src/index.js";

const token = "a".repeat(43);
const validRequest = {
  jsonrpc: "2.0",
  id: "handshake-1",
  method: "bridge/handshake",
  params: {
    authentication: { method: "token", token },
    role: "consumer",
    protocol: { minimum: "0.1.0", maximum: "0.1.0" },
    topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    clientInfo: { name: "test-client", version: "0.1.0" },
  },
};

describe("handshake runtime validation", () => {
  it("accepts the canonical request", () => {
    expect(isBridgeHandshakeRequest(validRequest)).toBe(true);
    expect(classifyBridgeHandshakeRequest(validRequest)).toEqual({
      kind: "valid",
      request: validRequest,
    });
  });

  it("classifies authentication-only schema failures without returning details", () => {
    const missingToken = {
      ...validRequest,
      params: { ...validRequest.params, authentication: { method: "token" } },
    };
    expect(classifyBridgeHandshakeRequest(missingToken)).toEqual({ kind: "authentication" });
  });

  it("does not hide non-authentication failures behind authentication errors", () => {
    const invalid = {
      ...validRequest,
      params: { ...validRequest.params, authentication: {}, role: "administrator" },
    };
    expect(classifyBridgeHandshakeRequest(invalid)).toEqual({ kind: "invalid" });
  });

  it("only accepts non-empty strings and safe integer request identifiers", () => {
    expect(isJSONRPCRequestIdentifier("request-1")).toBe(true);
    expect(isJSONRPCRequestIdentifier(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isJSONRPCRequestIdentifier("")).toBe(false);
    expect(isJSONRPCRequestIdentifier(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isJSONRPCRequestIdentifier(1.5)).toBe(false);
  });

  it("classifies canonical daemon success and error responses", () => {
    const success = {
      jsonrpc: "2.0",
      id: "handshake-1",
      result: {
        sessionId: "session_test",
        role: "consumer",
        protocolVersion: "0.1.0",
        daemonInfo: { name: "ide-bridge-daemon", version: "0.0.0" },
        topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
      },
    };
    const failure = {
      jsonrpc: "2.0",
      id: "handshake-1",
      error: {
        code: -32001,
        message: "Authentication failed",
        data: { code: "AUTHENTICATION_FAILED", retryable: false },
      },
    };

    expect(isBridgeHandshakeResponse(success)).toBe(true);
    expect(isBridgeHandshakeErrorResponse(failure)).toBe(true);
    expect(classifyBridgeHandshakeServerMessage(success)).toEqual({
      kind: "success",
      response: success,
    });
    expect(classifyBridgeHandshakeServerMessage(failure)).toEqual({
      kind: "error",
      response: failure,
    });
  });

  it("rejects malformed daemon responses without returning their contents", () => {
    const secret = "secret-that-must-not-be-reported";
    const invalid = {
      jsonrpc: "2.0",
      id: "handshake-1",
      error: {
        code: -32001,
        message: "Authentication failed",
        data: { code: "AUTHENTICATION_FAILED", retryable: false, token: secret },
      },
    };
    expect(classifyBridgeHandshakeServerMessage(invalid)).toEqual({ kind: "invalid" });
  });
});
