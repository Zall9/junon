import { describe, it, expect } from "vitest";
import { CONFORMANCE_NAME } from "../src/index.js";

describe("conformance skeleton", () => {
  it("should export CONFORMANCE_NAME", () => {
    expect(CONFORMANCE_NAME).toBe("ide-bridge-conformance");
  });
});
