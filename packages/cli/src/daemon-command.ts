import { unlink } from "node:fs/promises";

import { readPrivateDiscoveryFile } from "@ide-bridge/bridge-client";
import {
  IDEBPDaemonServer,
  StructuredLogger,
  createStderrJsonLineSink,
  generateAuthenticationToken,
  writePrivateDiscoveryFile,
  type StructuredLogLevel,
} from "@ide-bridge/bridge-daemon";
import type { IDEBPDiscoveryFile } from "@ide-bridge/protocol";

import {
  acquireDaemonOwnership,
  releaseDaemonOwnership,
  type DaemonOwnership,
} from "./ownership.js";

function createShutdownSignal(): { promise: Promise<void>; dispose: () => void } {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  return {
    promise,
    dispose: () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
    },
  };
}

async function removeOwnedDiscoveryFile(
  filePath: string,
  expected: IDEBPDiscoveryFile,
): Promise<void> {
  try {
    const current = await readPrivateDiscoveryFile(filePath);
    if (
      current.endpoint === expected.endpoint &&
      current.token === expected.token &&
      current.pid === expected.pid &&
      current.startedAt === expected.startedAt
    ) {
      await unlink(filePath);
    }
  } catch {
    // Never remove discovery state whose ownership cannot be proven.
  }
}

export async function runDaemonCommand(
  discoveryFile: string,
  logLevel: StructuredLogLevel,
  writeOutput: (value: unknown) => void,
  /**
   * Whether to start the read-only local dashboard surface (ADR-0035).
   *
   * Opt-in, because a port nobody asked for is a port nobody is watching. The URL is returned to the
   * caller rather than logged: the structured log is an artifact that travels, and the launch token
   * would travel with it.
   */
  dashboard = false,
): Promise<void> {
  const shutdownSignal = createShutdownSignal();
  const startedAt = new Date();
  const owner = { pid: process.pid, startedAt: startedAt.toISOString() };
  let ownership: DaemonOwnership | undefined;
  let server: IDEBPDaemonServer | undefined;
  let discovery: IDEBPDiscoveryFile | undefined;
  try {
    ownership = await acquireDaemonOwnership(discoveryFile, owner);
    const token = generateAuthenticationToken();
    const logger = new StructuredLogger({
      minimumLevel: logLevel,
      sink: createStderrJsonLineSink(),
    });
    server = new IDEBPDaemonServer({ expectedToken: token, logger });
    const endpoint = await server.start();
    discovery = await writePrivateDiscoveryFile({
      filePath: discoveryFile,
      endpoint,
      token,
      pid: owner.pid,
      startedAt,
    });
    const dashboardUrl = dashboard ? (await server.startDashboard()).url : undefined;
    writeOutput({
      ok: true,
      command: "daemon",
      status: "ready",
      pid: process.pid,
      ...(dashboardUrl === undefined ? {} : { dashboard: dashboardUrl }),
    });
    await shutdownSignal.promise;
  } finally {
    shutdownSignal.dispose();
    await server?.close().catch(() => undefined);
    if (discovery !== undefined) await removeOwnedDiscoveryFile(discoveryFile, discovery);
    if (ownership !== undefined) await releaseDaemonOwnership(ownership);
  }
}
