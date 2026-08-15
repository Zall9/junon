import { describe, it, expect } from "vitest";
import { CLIENT_NAME } from "../src/index.js";

describe("bridge-client skeleton", () => {
  it("should export CLIENT_NAME", () => {
    expect(CLIENT_NAME).toBe("ide-bridge-client");
  });
});
