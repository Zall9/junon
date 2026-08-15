import { describe, it, expect, vi } from "vitest";

// Mock the 'vscode' module — it is provided by the VS Code extension host at
// runtime, not available as an installable npm package during testing.
vi.mock("vscode", () => ({}));

import { EXTENSION_ID } from "../src/extension.js";

describe("vscode-extension entry", () => {
  it("should export EXTENSION_ID", () => {
    expect(EXTENSION_ID).toBe("ide-bridge.vscode-extension");
  });
});
