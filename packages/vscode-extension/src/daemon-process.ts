import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import type { ExtensionLogLevel } from "./configuration.js";

export interface OwnedDaemonProcess {
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export interface SpawnDaemonOptions {
  scriptPath: string;
  discoveryFile: string;
  logLevel: ExtensionLogLevel;
}

const GRACEFUL_STOP_TIMEOUT_MS = 3_000;

export function spawnOwnedDaemon(options: SpawnDaemonOptions): OwnedDaemonProcess {
  if (!isAbsolute(options.scriptPath) || options.scriptPath.includes("\0")) {
    throw new Error("Bundled daemon child path is invalid");
  }
  const child = spawn(
    process.execPath,
    [
      options.scriptPath,
      "daemon",
      "--discovery-file",
      options.discoveryFile,
      "--log-level",
      options.logLevel,
    ],
    {
      detached: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  return ownedProcess(child);
}

function ownedProcess(child: ChildProcess): OwnedDaemonProcess {
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (exited) return;
      exited = true;
      resolve();
    };
    child.once("error", finish);
    child.once("exit", finish);
  });
  let stopTask: Promise<void> | undefined;
  return {
    exited: exitPromise,
    stop: async () => {
      stopTask ??= stopOwnedProcess(child, exitPromise, () => exited);
      await stopTask;
    },
  };
}

async function stopOwnedProcess(
  child: ChildProcess,
  exited: Promise<void>,
  hasExited: () => boolean,
): Promise<void> {
  if (hasExited()) return;
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => {
        resolve(false);
      }, GRACEFUL_STOP_TIMEOUT_MS);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!graceful && !hasExited()) child.kill("SIGKILL");
  await exited;
}
