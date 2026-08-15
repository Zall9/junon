import { describe, expect, it, vi } from "vitest";

import type { ConfigurationLike } from "../src/configuration.js";
import { readAdapterConfiguration } from "../src/configuration.js";
import { createSafeLifecycleLogger } from "../src/safe-logger.js";
import { createVscodeTopology } from "../src/topology.js";

function configuration(values: Record<string, unknown>): ConfigurationLike {
  return { get: (section: string) => values[section] };
}

describe("VS Code adapter configuration and topology", () => {
  it("resolves secure defaults without storing authentication in settings", () => {
    expect(
      readAdapterConfiguration(configuration({}), {
        environment: {},
        homeDirectory: "/home/tester",
      }),
    ).toEqual({
      autoStartDaemon: true,
      discoveryFile: "/home/tester/.ide-bridge/discovery.json",
      logLevel: "info",
      providerTimeoutMs: 30_000,
    });
  });

  // The setting's declared default is the empty string, and the resolver reads "" as a configured
  // value rather than as an absence — so the environment variable this extension documents was
  // never consulted. Measured cost: an end-to-end suite that believed it ran against its own
  // sandboxed daemon spent three days talking to one started by hand, on a three-day-old build,
  // and blamed four innocent parts of the system for the answer it got.
  it("takes the discovery file from the environment when the setting is left empty", () => {
    const fromEnvironment = { IDE_BRIDGE_DISCOVERY_FILE: "/sandbox/discovery.json" };
    expect(
      readAdapterConfiguration(configuration({}), {
        environment: fromEnvironment,
        homeDirectory: "/home/tester",
      }).discoveryFile,
    ).toBe("/sandbox/discovery.json");
    // An explicitly empty setting means the same thing as an absent one.
    expect(
      readAdapterConfiguration(configuration({ discoveryFile: "   " }), {
        environment: fromEnvironment,
        homeDirectory: "/home/tester",
      }).discoveryFile,
    ).toBe("/sandbox/discovery.json");
    // A real setting still wins over the environment.
    expect(
      readAdapterConfiguration(configuration({ discoveryFile: "/explicit/discovery.json" }), {
        environment: fromEnvironment,
        homeDirectory: "/home/tester",
      }).discoveryFile,
    ).toBe("/explicit/discovery.json");
  });

  it("accepts only bounded values and loopback endpoint overrides", () => {
    expect(
      readAdapterConfiguration(
        configuration({
          autoStartDaemon: false,
          discoveryFile: "state/discovery.json",
          manualEndpoint: " ws://127.0.0.1:43127/rpc ",
          logLevel: "debug",
          providerTimeoutMs: 2_500,
        }),
        { currentDirectory: "/workspace" },
      ),
    ).toEqual({
      autoStartDaemon: false,
      discoveryFile: "/workspace/state/discovery.json",
      endpointOverride: "ws://127.0.0.1:43127/rpc",
      logLevel: "debug",
      providerTimeoutMs: 2_500,
    });

    expect(() =>
      readAdapterConfiguration(configuration({ manualEndpoint: "ws://example.com:43127/rpc" })),
    ).toThrow("loopback");
    expect(() => readAdapterConfiguration(configuration({ providerTimeoutMs: 300_001 }))).toThrow(
      "configuration is invalid",
    );
  });

  it("announces actual root schemes and the remote extension-host kind", () => {
    expect(
      createVscodeTopology({
        appHost: "desktop",
        remoteName: "ssh-remote+devbox",
        workspaceFolders: [
          {
            name: "project",
            uri: { scheme: "vscode-remote", toString: () => "vscode-remote://devbox/project" },
          },
        ],
      }),
    ).toEqual({
      hostKind: "remote-workspace",
      environmentKind: "ssh",
      uriSchemes: ["vscode-remote"],
    });
    expect(createVscodeTopology({ appHost: "desktop" })).toEqual({
      hostKind: "local",
      environmentKind: "local",
      uriSchemes: ["file"],
    });
  });

  it("logs only closed lifecycle event names and applies the configured threshold", () => {
    const channel = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const logger = createSafeLifecycleLogger(channel, "warn");
    logger.info("adapter-connected");
    logger.warn("adapter-reconnecting");
    logger.error("activation-failed");

    expect(channel.info).not.toHaveBeenCalled();
    expect(channel.warn).toHaveBeenCalledWith("[lifecycle] adapter-reconnecting");
    expect(channel.error).toHaveBeenCalledWith("[lifecycle] activation-failed");
  });
});
