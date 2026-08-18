import {
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientHandshakeTimeoutError,
  BridgeClientProtocolViolationError,
  BridgeHandshakeRejectedError,
} from "@ide-bridge/bridge-client";

import { CLI_REQUEST_TIMEOUT_MS, withCliConsumer } from "./admin-client.js";
import { parseCliArguments, CliUsageError } from "./arguments.js";
import { runDaemonCommand } from "./daemon-command.js";
import { runDoctor } from "./doctor.js";
import { CliOperationalError, type CliOperationalErrorCode } from "./errors.js";
import { resolveDiscoveryFilePath } from "./paths.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

const HELP = `Usage: ide-bridge <command> [options]

Commands:
  daemon       Run the loopback daemon in the foreground
  status       Show daemon status
  adapters     List registered IDE adapters
  workspaces   List registered workspaces
  doctor       Run read-only health checks

Options:
  --discovery-file <path>  Override the private discovery file
  --log-level <level>      daemon only: debug|info|warn|error|silent
  --dashboard              daemon only: start the read-only local dashboard surface
  --check-updates          doctor only: ask the plugin repository for the latest release
  --help, -h               Show this help
`;

function writeJson(writer: (line: string) => void, value: unknown): void {
  writer(`${JSON.stringify(value)}\n`);
}

function operationalErrorCode(error: unknown): CliOperationalErrorCode {
  if (error instanceof CliOperationalError) return error.code;
  if (error instanceof BridgeHandshakeRejectedError) {
    return error.protocolCode === "UNSUPPORTED_PROTOCOL_VERSION"
      ? "protocol-incompatible"
      : "daemon-unavailable";
  }
  if (error instanceof BridgeClientConfigurationError) return "discovery-unavailable";
  if (
    error instanceof BridgeClientConnectionError ||
    error instanceof BridgeClientHandshakeTimeoutError ||
    error instanceof BridgeClientProtocolViolationError
  ) {
    return "daemon-unavailable";
  }
  return "internal-error";
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    const detail = error instanceof CliUsageError ? error.code : "unexpected-argument";
    writeJson(io.stderr, { ok: false, error: "usage", detail });
    return 2;
  }
  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }
  if ((io.platform ?? process.platform) === "win32") {
    writeJson(io.stderr, { ok: false, error: "platform-unsupported" });
    return 1;
  }

  let discoveryFile: string;
  try {
    discoveryFile = resolveDiscoveryFilePath(parsed.discoveryFile, {
      ...(io.environment === undefined ? {} : { environment: io.environment }),
      ...(io.currentDirectory === undefined ? {} : { currentDirectory: io.currentDirectory }),
      ...(io.homeDirectory === undefined ? {} : { homeDirectory: io.homeDirectory }),
    });
  } catch {
    writeJson(io.stderr, { ok: false, error: "discovery-unavailable" });
    return 1;
  }

  try {
    switch (parsed.command) {
      case "daemon":
        await runDaemonCommand(
          discoveryFile,
          parsed.logLevel,
          (value) => {
            writeJson(io.stdout, value);
          },
          parsed.dashboard,
        );
        return 0;
      case "status": {
        const result = await withCliConsumer(
          discoveryFile,
          async (connection) =>
            await connection.request("bridge/getStatus", {}, { timeoutMs: CLI_REQUEST_TIMEOUT_MS }),
        );
        writeJson(io.stdout, { ok: true, command: "status", result });
        return 0;
      }
      case "adapters": {
        const result = await withCliConsumer(
          discoveryFile,
          async (connection) =>
            await connection.request(
              "bridge/listAdapters",
              {},
              { timeoutMs: CLI_REQUEST_TIMEOUT_MS },
            ),
        );
        writeJson(io.stdout, { ok: true, command: "adapters", result });
        return 0;
      }
      case "workspaces": {
        const result = await withCliConsumer(
          discoveryFile,
          async (connection) =>
            await connection.request("workspace/list", {}, { timeoutMs: CLI_REQUEST_TIMEOUT_MS }),
        );
        writeJson(io.stdout, { ok: true, command: "workspaces", result });
        return 0;
      }
      case "doctor": {
        const report = await runDoctor(discoveryFile, { checkUpdates: parsed.checkUpdates });
        writeJson(io.stdout, { command: "doctor", ...report });
        return report.ok ? 0 : 1;
      }
      case undefined:
        writeJson(io.stderr, { ok: false, error: "usage", detail: "missing-command" });
        return 2;
    }
  } catch (error) {
    writeJson(io.stderr, {
      ok: false,
      command: parsed.command,
      error: operationalErrorCode(error),
    });
    return 1;
  }
}
