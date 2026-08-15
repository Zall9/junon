import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isUriWithinWorkspaceRoot } from "../src/security/workspace-uri.js";

/**
 * Driven by the shared vector file rather than by cases restated here.
 *
 * Every adapter implements this rule in its own language, and one whose rule is looser than the
 * daemon's is closed as a policy violation. Checking both implementations against the same list is
 * what stops them drifting (ADR-0025).
 */
const vectorsPath = fileURLToPath(
  new URL("../../protocol/fixtures/vectors/uri-containment-vectors.json", import.meta.url),
);
const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  vectors: { documentUri: string; rootUri: string; contained: boolean; why: string }[];
};

describe("workspace URI authorization", () => {
  it.each(vectors)("$why", ({ documentUri, rootUri, contained }) => {
    expect(isUriWithinWorkspaceRoot(documentUri, rootUri)).toBe(contained);
  });

  it("covers both containment outcomes", () => {
    expect(vectors.some((vector) => vector.contained)).toBe(true);
    expect(vectors.some((vector) => !vector.contained)).toBe(true);
  });
});
