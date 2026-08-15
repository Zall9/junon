import { lstat } from "node:fs/promises";

import { readPrivateDiscoveryFile } from "@ide-bridge/bridge-client";
import {
  MAX_HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_HEARTBEATS,
  compareProtocolVersions,
} from "@ide-bridge/bridge-daemon";
import { PROTOCOL_VERSION } from "@ide-bridge/protocol";
import type { AuthenticatedBridgeConnection } from "@ide-bridge/bridge-client";

import { CLI_REQUEST_TIMEOUT_MS, connectCliConsumer } from "./admin-client.js";
import { isProcessAlive } from "./ownership.js";

const MAX_SESSION_ACTIVITY_AGE_MS = MAX_HEARTBEAT_INTERVAL_MS * (MAX_MISSED_HEARTBEATS + 2);
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;

export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name:
    | "discovery-file"
    | "permissions"
    | "daemon-process"
    | "port"
    | "protocol"
    | "adapters"
    | "sessions-expired";
  status: DoctorCheckStatus;
  detail: string;
}

/**
 * Which daemon answered, and since when.
 *
 * Every check in this report can pass against a daemon started days ago from a build nobody has
 * seen since — alive, reachable, protocol-compatible, and wrong. That happened: three days of
 * end-to-end measurements were taken against a daemon from 2026-08-11 while the suite believed it
 * had started its own (ADR-0037). No check would have caught it; this identity would have.
 *
 * It carries no token and no endpoint — the discovery file holds authentication material, and a
 * diagnostic that prints it turns a support paste into a credential leak.
 */
export interface DoctorDaemonIdentity {
  discoveryFile: string;
  pid: number;
  startedAt: string;
  /** Whole seconds since `startedAt`, or `undefined` when the timestamp cannot be read. */
  uptimeSeconds: number | undefined;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** Absent only when the discovery file could not be read at all. */
  daemon?: DoctorDaemonIdentity;
}

async function permissionCheck(filePath: string): Promise<DoctorCheck> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { name: "permissions", status: "fail", detail: "not-private-regular-file" };
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      return { name: "permissions", status: "fail", detail: "wrong-owner" };
    }
    const mode = metadata.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return { name: "permissions", status: "fail", detail: "too-broad" };
    }
    return mode === 0o600
      ? { name: "permissions", status: "pass", detail: "mode-0600" }
      : { name: "permissions", status: "warn", detail: "private-noncanonical-mode" };
  } catch {
    return { name: "permissions", status: "fail", detail: "unreadable" };
  }
}

function skipped(name: DoctorCheck["name"]): DoctorCheck {
  return { name, status: "skip", detail: "prerequisite-unavailable" };
}

async function adapterCheck(connection: AuthenticatedBridgeConnection): Promise<DoctorCheck> {
  try {
    const [{ adapters }, { workspaces }] = await Promise.all([
      connection.request("bridge/listAdapters", {}, { timeoutMs: CLI_REQUEST_TIMEOUT_MS }),
      connection.request("workspace/list", {}, { timeoutMs: CLI_REQUEST_TIMEOUT_MS }),
    ]);
    if (adapters.length === 0) {
      return { name: "adapters", status: "warn", detail: "no-adapter-registered" };
    }
    const statuses = await Promise.all(
      workspaces.map(
        async ({ workspaceId }) =>
          await connection.request(
            "workspace/getStatus",
            { workspaceId },
            { timeoutMs: CLI_REQUEST_TIMEOUT_MS },
          ),
      ),
    );
    const states = statuses.map(({ status }) => status.state);
    if (states.includes("disconnected")) {
      return { name: "adapters", status: "fail", detail: "workspace-disconnected" };
    }
    if (workspaces.length === 0 || states.some((state) => state !== "ready")) {
      return { name: "adapters", status: "warn", detail: "workspace-not-ready" };
    }
    return { name: "adapters", status: "pass", detail: "registered-and-ready" };
  } catch {
    return { name: "adapters", status: "fail", detail: "state-query-failed" };
  }
}

async function sessionExpirationCheck(
  connection: AuthenticatedBridgeConnection,
  now: Date,
): Promise<DoctorCheck> {
  try {
    const { sessions } = await connection.request(
      "bridge/listSessions",
      {},
      { timeoutMs: CLI_REQUEST_TIMEOUT_MS },
    );
    const currentTime = now.getTime();
    const stale = sessions.some(({ lastActivityAt }) => {
      const activityTime = Date.parse(lastActivityAt);
      return (
        !Number.isFinite(activityTime) ||
        activityTime > currentTime + MAX_FUTURE_CLOCK_SKEW_MS ||
        currentTime - activityTime > MAX_SESSION_ACTIVITY_AGE_MS
      );
    });
    return stale
      ? { name: "sessions-expired", status: "fail", detail: "stale-session-present" }
      : { name: "sessions-expired", status: "pass", detail: "within-heartbeat-bound" };
  } catch {
    return { name: "sessions-expired", status: "fail", detail: "state-query-failed" };
  }
}

export async function runDoctor(
  discoveryFile: string,
  options: { now?: () => Date } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let discovery;
  try {
    discovery = await readPrivateDiscoveryFile(discoveryFile);
    checks.push({ name: "discovery-file", status: "pass", detail: "valid" });
  } catch {
    checks.push({ name: "discovery-file", status: "fail", detail: "invalid-or-unreadable" });
  }
  checks.push(await permissionCheck(discoveryFile));
  if (discovery === undefined) {
    checks.push(skipped("daemon-process"), skipped("port"), skipped("protocol"));
    checks.push(skipped("adapters"), skipped("sessions-expired"));
    return { ok: false, checks };
  }

  const daemon = identify(discoveryFile, discovery, options.now?.() ?? new Date());
  const daemonProcessAlive = isProcessAlive(discovery.pid);
  checks.push({
    name: "daemon-process",
    status: daemonProcessAlive ? "pass" : "fail",
    detail: daemonProcessAlive ? "pid-alive" : "pid-not-running",
  });

  let connection: AuthenticatedBridgeConnection;
  try {
    connection = await connectCliConsumer(discoveryFile);
    checks.push({ name: "port", status: "pass", detail: "authenticated-loopback-reachable" });
  } catch {
    checks.push({ name: "port", status: "fail", detail: "unreachable-or-rejected" });
    checks.push(skipped("protocol"), skipped("adapters"), skipped("sessions-expired"));
    return { ok: false, checks, daemon };
  }

  try {
    try {
      const status = await connection.request(
        "bridge/getStatus",
        {},
        { timeoutMs: CLI_REQUEST_TIMEOUT_MS },
      );
      const compatible =
        connection.session.protocolVersion === PROTOCOL_VERSION &&
        compareProtocolVersions(PROTOCOL_VERSION, status.protocol.minimum) >= 0 &&
        compareProtocolVersions(PROTOCOL_VERSION, status.protocol.maximum) <= 0;
      checks.push({
        name: "protocol",
        status: compatible ? "pass" : "fail",
        detail: compatible ? "compatible" : "incompatible",
      });
    } catch {
      checks.push({ name: "protocol", status: "fail", detail: "status-query-failed" });
    }
    checks.push(await adapterCheck(connection));
    checks.push(await sessionExpirationCheck(connection, options.now?.() ?? new Date()));
  } finally {
    await connection.close().catch(() => undefined);
  }
  return { ok: checks.every(({ status }) => status !== "fail"), checks, daemon };
}

/** Names the daemon behind the discovery file, without repeating anything secret from it. */
function identify(
  discoveryFile: string,
  discovery: { pid: number; startedAt: string },
  now: Date,
): DoctorDaemonIdentity {
  const startedAt = Date.parse(discovery.startedAt);
  return {
    discoveryFile,
    pid: discovery.pid,
    startedAt: discovery.startedAt,
    uptimeSeconds: Number.isNaN(startedAt)
      ? undefined
      : Math.max(0, Math.floor((now.getTime() - startedAt) / 1000)),
  };
}
