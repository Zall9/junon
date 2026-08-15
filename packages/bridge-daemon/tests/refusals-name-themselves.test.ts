import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A guard, in the same spirit as the protocol count guards: adding a refusal has to be an
 * acknowledged act rather than something absorbed silently.
 *
 * Every `PROVIDER_FAILED` the router throws closes the offending adapter's session. For most of this
 * project's life those refusals carried a code and nothing else, which told an adapter author that
 * their response was rejected but never by which rule. That cost six wrong explanations of a single
 * `workspace/undo` defect; what finally settled it was one run in which the check said its own name.
 *
 * So: no bare `PROVIDER_FAILED` in the router. If a new one is genuinely unnameable, this guard is
 * the place to argue for the exception rather than the place to quietly delete.
 */
describe("router refusals", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/routing/application-router.ts", import.meta.url)),
    "utf8",
  );

  it("never refuses without naming the condition", () => {
    const bare = [...source.matchAll(/new EditStoreError\("PROVIDER_FAILED"\)/g)];

    expect(bare).toHaveLength(0);
  });

  it("keeps every literal close reason inside a close frame", () => {
    // Over 123 bytes `close()` throws instead of truncating, the session stays open, and an adapter
    // that violated the contract keeps its connection. `clampCloseReason` covers the composed
    // reasons; these are the ones written out by hand, where nothing clamps them.
    const literals = [...source.matchAll(/connection\.close\(\d{4}, "([^"]+)"\)/g)].map(
      (match) => match[1] as string,
    );

    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(
        Buffer.byteLength(literal, "utf8"),
        `close reason too long to send: ${literal}`,
      ).toBeLessThanOrEqual(123);
    }
  });
});
