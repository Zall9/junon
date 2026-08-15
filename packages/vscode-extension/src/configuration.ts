import { resolveDiscoveryFilePath } from "@ide-bridge/cli";
import { assertIDEBPLoopbackEndpoint } from "@ide-bridge/protocol";

export type ExtensionLogLevel = "debug" | "error" | "info" | "warn";

export interface ConfigurationLike {
  get(section: string): unknown;
}

export interface AdapterConfiguration {
  autoStartDaemon: boolean;
  discoveryFile: string;
  endpointOverride?: string;
  logLevel: ExtensionLogLevel;
  providerTimeoutMs: number;
}

export interface ConfigurationEnvironment {
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  homeDirectory?: string;
}

const LOG_LEVELS = new Set<ExtensionLogLevel>(["debug", "error", "info", "warn"]);

export function readAdapterConfiguration(
  configuration: ConfigurationLike,
  environment: ConfigurationEnvironment = {},
): AdapterConfiguration {
  const autoStartDaemon = configuration.get("autoStartDaemon") ?? true;
  const discoverySetting = configuration.get("discoveryFile") ?? "";
  const endpointSetting = configuration.get("manualEndpoint") ?? "";
  const logLevel = configuration.get("logLevel") ?? "info";
  const providerTimeoutMs = configuration.get("providerTimeoutMs") ?? 30_000;

  if (
    typeof autoStartDaemon !== "boolean" ||
    typeof discoverySetting !== "string" ||
    typeof endpointSetting !== "string" ||
    typeof logLevel !== "string" ||
    !LOG_LEVELS.has(logLevel as ExtensionLogLevel) ||
    !Number.isSafeInteger(providerTimeoutMs) ||
    (providerTimeoutMs as number) < 100 ||
    (providerTimeoutMs as number) > 300_000
  ) {
    throw new Error("IDE Bridge extension configuration is invalid");
  }

  const endpointOverride = endpointSetting.trim();
  if (endpointOverride.length > 0) assertIDEBPLoopbackEndpoint(endpointOverride);

  // The setting's default is the empty string, and `resolveDiscoveryFilePath` distinguishes
  // "unset" from "empty" by `undefined` alone — so passing the raw setting through meant
  // IDE_BRIDGE_DISCOVERY_FILE was never consulted by this extension, whatever the documentation
  // said. Measured: an end-to-end run that believed it had its own sandboxed daemon spent three
  // days talking to a daemon started by hand on another build.
  const configuredDiscoveryFile = discoverySetting.trim();

  return {
    autoStartDaemon,
    discoveryFile: resolveDiscoveryFilePath(
      configuredDiscoveryFile.length === 0 ? undefined : configuredDiscoveryFile,
      environment,
    ),
    ...(endpointOverride.length === 0 ? {} : { endpointOverride }),
    logLevel: logLevel as ExtensionLogLevel,
    providerTimeoutMs: providerTimeoutMs as number,
  };
}
