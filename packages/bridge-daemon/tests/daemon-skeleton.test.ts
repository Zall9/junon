import { describe, it, expect } from "vitest";
import { DAEMON_NAME } from "../src/index.js";

describe("bridge-daemon skeleton", () => {
  it("should export DAEMON_NAME", () => {
    expect(DAEMON_NAME).toBe("ide-bridge-daemon");
  });
});
