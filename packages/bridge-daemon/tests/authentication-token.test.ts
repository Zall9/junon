import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_TOKEN_BYTES,
  authenticationTokensEqual,
  generateAuthenticationToken,
  isAuthenticationToken,
} from "../src/security/authentication-token.js";

describe("daemon authentication tokens", () => {
  it("generates unique unpadded base64url tokens with 256 bits of entropy", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateAuthenticationToken()));

    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(isAuthenticationToken(token)).toBe(true);
      expect(token).not.toContain("=");
      expect(Buffer.from(token, "base64url")).toHaveLength(AUTHENTICATION_TOKEN_BYTES);
    }
  });

  it("accepts only the exact token", () => {
    const expected = generateAuthenticationToken();
    const different = generateAuthenticationToken();

    expect(authenticationTokensEqual(expected, expected)).toBe(true);
    expect(authenticationTokensEqual(expected, different)).toBe(false);
    expect(authenticationTokensEqual(expected, "short")).toBe(false);
    expect(authenticationTokensEqual(expected, "a".repeat(513))).toBe(false);
    expect(authenticationTokensEqual(expected, undefined)).toBe(false);
  });
});
