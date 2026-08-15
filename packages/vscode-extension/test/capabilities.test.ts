import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { IDEBP_ROUTED_METHODS } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import { ADAPTER_CAPABILITIES } from "../src/capabilities.js";

/**
 * The routed methods as the protocol's **source** declares them.
 *
 * Read as text rather than imported, because importing would go through the same build this is
 * checking. Compared by content rather than by file timestamps: an earlier attempt used mtimes and
 * was flaky, since `tsc` only rewrites the outputs that changed and any tool touching a file moves
 * the comparison — a guard that cries wolf is one people learn to ignore.
 */
/**
 * Locates the protocol source without depending on the working directory.
 *
 * The first version resolved `../protocol` against `process.cwd()`, on the stated assumption that
 * vitest runs from the package root. It does when the package is tested alone; `pnpm test` at the
 * repository root runs one vitest across the workspace, where that same path pointed outside the
 * repository entirely and the guard died of ENOENT. Walking up for a known landmark holds either
 * way, and `import.meta` stays unused — this package's test tsconfig targets a module format
 * without it.
 */
function protocolSourcePath(): string {
  const landmark = join("packages", "protocol", "src", "application-validation.ts");
  let directory = process.cwd();
  for (;;) {
    const candidate = resolve(directory, landmark);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`could not find ${landmark} in any directory above ${process.cwd()}`);
    }
    directory = parent;
  }
}

function routedMethodsInSource(): string[] {
  const source = readFileSync(protocolSourcePath(), "utf8");
  // `Object.freeze([...])`, so the opening bracket is not adjacent to the `=`.
  const declaration = /IDEBP_ROUTED_METHODS\s*=[^[]*\[([^\]]*)\]/s.exec(source);
  if (declaration === null) return [];
  return [...(declaration[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/**
 * Conformance: an adapter must account for every routed method.
 *
 * A method the daemon can route but the adapter never mentions is not a smaller capability set —
 * it is a consumer that receives no answer and no explanation. The JetBrains adapter is held to
 * the same rule by `CatalogueCoverageTest`, against this same list, so the two cannot drift into
 * describing the protocol differently.
 */
describe("adapter capability declaration", () => {
  /**
   * This package reads `@ide-bridge/protocol` from its **build**, not its source, so the guard
   * below compares a fresh capability list against whatever was last compiled. Three times in one
   * day that made it pass while a method was missing — and it passed at exactly the moment a method
   * was added, which is the only moment it exists to speak up.
   *
   * A guard that goes quiet when the thing it guards changes is worse than no guard, so staleness
   * is now a failure of its own rather than a silent weakening of the next assertion.
   */
  it("is judging a protocol build that is not stale", () => {
    const authored = routedMethodsInSource();

    expect(
      authored.length,
      "could not read IDEBP_ROUTED_METHODS from the protocol source; this guard is not guarding",
    ).toBeGreaterThan(0);
    expect(
      [...IDEBP_ROUTED_METHODS].sort(),
      "the built protocol disagrees with its source about which methods are routed, so every check " +
        "below is judging a stale contract — run `pnpm -r run build`",
    ).toEqual([...authored].sort());
  });

  it("accounts for every routed method, none omitted", () => {
    expect(Object.keys(ADAPTER_CAPABILITIES).sort()).toEqual([...IDEBP_ROUTED_METHODS].sort());
  });

  it("declares nothing the daemon would never route to it", () => {
    for (const method of Object.keys(ADAPTER_CAPABILITIES)) {
      expect(IDEBP_ROUTED_METHODS).toContain(method);
    }
  });

  it("explains every unavailable capability", () => {
    for (const [method, capability] of Object.entries(ADAPTER_CAPABILITIES)) {
      if (capability?.support !== "unavailable") continue;
      // An unexplained refusal leaves a consumer unable to tell a missing feature from a bug.
      expect(capability.reason, `${method} must say why it is unavailable`).toBeTruthy();
    }
  });

  // A fourth check — that an unavailable capability claims no guarantee — was written and then
  // removed: `UnavailableCapability` has no `guarantee` field, so the type makes it unwritable.
  // A test that cannot fail is worse than no test, because it reads like coverage.
});
