import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTHENTICATION_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/u;

/** Generate an unpadded base64url token with 256 bits of CSPRNG entropy. */
export function generateAuthenticationToken(): string {
  return randomBytes(AUTHENTICATION_TOKEN_BYTES).toString("base64url");
}

/** Validate the wire representation before accepting a token for comparison. */
export function isAuthenticationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * Compare authentication tokens without exposing their length through the comparison primitive.
 * Hashing produces fixed-size inputs for timingSafeEqual; invalid wire representations are rejected.
 */
export function authenticationTokensEqual(expected: string, supplied: unknown): boolean {
  if (!isAuthenticationToken(expected) || !isAuthenticationToken(supplied)) return false;

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}
