import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArguments } from "../src/arguments.js";
import { resolveDiscoveryFilePath } from "../src/paths.js";

describe("CLI arguments and paths", () => {
  it("parses every command and daemon-specific options", () => {
    for (const command of ["daemon", "status", "adapters", "workspaces", "doctor"] as const) {
      expect(parseCliArguments([command])).toMatchObject({ command, help: false });
    }
    expect(
      parseCliArguments([
        "daemon",
        "--discovery-file",
        "runtime/discovery.json",
        "--log-level",
        "warn",
      ]),
    ).toEqual({
      command: "daemon",
      discoveryFile: "runtime/discovery.json",
      logLevel: "warn",
      logLevelSpecified: true,
      dashboard: false,
      checkUpdates: false,
      help: false,
    });
  });

  it("parses the dashboard flag, and refuses it on commands that cannot honour it", () => {
    expect(parseCliArguments(["daemon", "--dashboard"])).toMatchObject({
      command: "daemon",
      dashboard: true,
      checkUpdates: false,
    });
    // Refused rather than ignored: a flag silently accepted where it does nothing teaches the reader
    // that it did something.
    for (const command of ["status", "adapters", "workspaces", "doctor"] as const) {
      expect(() => parseCliArguments([command, "--dashboard"])).toThrow();
    }
  });

  it("rejects unknown, incomplete, or misplaced arguments", () => {
    for (const args of [
      [],
      ["unknown"],
      ["status", "extra"],
      ["status", "--unknown"],
      ["daemon", "--discovery-file"],
      ["daemon", "--log-level", "verbose"],
      ["status", "--log-level", "info"],
    ]) {
      expect(() => parseCliArguments(args)).toThrow(CliUsageError);
    }
  });

  it("resolves explicit, environment, and default discovery paths", () => {
    expect(
      resolveDiscoveryFilePath("relative/discovery.json", { currentDirectory: "/workspace" }),
    ).toBe(resolve("/workspace", "relative/discovery.json"));
    expect(
      resolveDiscoveryFilePath(undefined, {
        environment: { IDE_BRIDGE_DISCOVERY_FILE: "/runtime/custom.json" },
        homeDirectory: "/home/user",
      }),
    ).toBe("/runtime/custom.json");
    expect(
      resolveDiscoveryFilePath(undefined, { environment: {}, homeDirectory: "/home/user" }),
    ).toBe("/home/user/.ide-bridge/discovery.json");
    expect(() => resolveDiscoveryFilePath("bad\0path")).toThrow("Discovery path is invalid");
  });
});
