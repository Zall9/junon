import type { StructuredLogLevel } from "@ide-bridge/bridge-daemon";

export type CliCommand = "daemon" | "status" | "adapters" | "workspaces" | "doctor";

export interface ParsedCliArguments {
  command: CliCommand | undefined;
  discoveryFile: string | undefined;
  logLevel: StructuredLogLevel;
  logLevelSpecified: boolean;
  /** `daemon --dashboard`: start the read-only local surface (ADR-0035). Off unless asked for. */
  dashboard: boolean;
  /**
   * `doctor --check-updates`: ask the plugin repository what the latest release is.
   *
   * Off unless asked for, and that is the whole design. Every other check in `doctor` reads this
   * machine; this one makes a request off it, so it happens when a person types the flag and at no
   * other time.
   */
  checkUpdates: boolean;
  help: boolean;
}

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
  readonly code:
    | "missing-command"
    | "unknown-command"
    | "unknown-option"
    | "missing-option-value"
    | "invalid-log-level"
    | "unexpected-argument";

  constructor(code: CliUsageError["code"]) {
    super("Invalid IDE Bridge command line");
    this.code = code;
  }
}

const COMMANDS = new Set<CliCommand>(["daemon", "status", "adapters", "workspaces", "doctor"]);
const LOG_LEVELS = new Set<StructuredLogLevel>(["debug", "info", "warn", "error", "silent"]);

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  let command: CliCommand | undefined;
  let discoveryFile: string | undefined;
  let logLevel: StructuredLogLevel = "info";
  let logLevelSpecified = false;
  let dashboard = false;
  let checkUpdates = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--discovery-file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError("missing-option-value");
      }
      discoveryFile = value;
      index += 1;
      continue;
    }
    if (argument === "--log-level") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError("missing-option-value");
      }
      if (!LOG_LEVELS.has(value as StructuredLogLevel)) {
        throw new CliUsageError("invalid-log-level");
      }
      logLevel = value as StructuredLogLevel;
      logLevelSpecified = true;
      index += 1;
      continue;
    }
    if (argument === "--dashboard") {
      dashboard = true;
      continue;
    }
    if (argument === "--check-updates") {
      checkUpdates = true;
      continue;
    }
    if (argument?.startsWith("-")) throw new CliUsageError("unknown-option");
    if (command !== undefined) throw new CliUsageError("unexpected-argument");
    if (!COMMANDS.has(argument as CliCommand)) throw new CliUsageError("unknown-command");
    command = argument as CliCommand;
  }

  if (!help && command === undefined) throw new CliUsageError("missing-command");
  if (logLevelSpecified && command !== undefined && command !== "daemon") {
    throw new CliUsageError("unexpected-argument");
  }
  // Refused rather than ignored on the other commands: silently accepting a flag that does nothing
  // teaches the reader it did something.
  if (dashboard && command !== undefined && command !== "daemon") {
    throw new CliUsageError("unexpected-argument");
  }
  // Same rule as `--dashboard` above: a flag that cannot act on the given command is a usage error,
  // not a no-op. `--check-updates` on `status` would otherwise look like it checked something.
  if (checkUpdates && command !== undefined && command !== "doctor") {
    throw new CliUsageError("unexpected-argument");
  }
  return {
    command,
    discoveryFile,
    logLevel,
    logLevelSpecified,
    dashboard,
    checkUpdates,
    help,
  };
}
