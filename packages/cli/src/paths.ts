import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveDiscoveryFilePath(
  explicitPath: string | undefined,
  options: {
    environment?: NodeJS.ProcessEnv;
    currentDirectory?: string;
    homeDirectory?: string;
  } = {},
): string {
  const environment = options.environment ?? process.env;
  const configured = explicitPath ?? environment["IDE_BRIDGE_DISCOVERY_FILE"];
  const candidate =
    configured === undefined || configured.length === 0
      ? join(options.homeDirectory ?? homedir(), ".ide-bridge", "discovery.json")
      : configured;
  if (candidate.length === 0 || candidate.includes("\0")) {
    throw new Error("Discovery path is invalid");
  }
  return isAbsolute(candidate)
    ? candidate
    : resolve(options.currentDirectory ?? process.cwd(), candidate);
}
