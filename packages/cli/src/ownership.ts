import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CliOperationalError } from "./errors.js";

const MAX_OWNERSHIP_BYTES = 1_024;
const MAX_ACQUISITION_ATTEMPTS = 8;

export interface DaemonOwner {
  pid: number;
  startedAt: string;
}

export interface DaemonOwnership {
  lockPath: string;
  owner: DaemonOwner;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isDaemonOwner(value: unknown): value is DaemonOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "pid" && key !== "startedAt")) return false;
  return (
    Number.isSafeInteger(record["pid"]) &&
    (record["pid"] as number) > 0 &&
    typeof record["startedAt"] === "string" &&
    Number.isFinite(Date.parse(record["startedAt"]))
  );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CliOperationalError("ownership-invalid");
  }
  await chmod(directory, 0o700);
}

async function readOwner(lockPath: string): Promise<DaemonOwner> {
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_OWNERSHIP_BYTES ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new CliOperationalError("ownership-invalid");
    }
    const serialized = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(serialized) > MAX_OWNERSHIP_BYTES) {
      throw new CliOperationalError("ownership-invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new CliOperationalError("ownership-invalid");
    }
    if (!isDaemonOwner(value)) throw new CliOperationalError("ownership-invalid");
    return value;
  } finally {
    await handle.close();
  }
}

async function publishOwner(lockPath: string, owner: DaemonOwner): Promise<void> {
  const directory = dirname(lockPath);
  const temporaryPath = join(
    directory,
    `.${basename(lockPath)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, lockPath);
    await chmod(lockPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function acquireDaemonOwnership(
  discoveryFile: string,
  owner: DaemonOwner,
): Promise<DaemonOwnership> {
  if (process.platform === "win32") throw new CliOperationalError("platform-unsupported");
  if (!isDaemonOwner(owner)) throw new CliOperationalError("ownership-invalid");
  const lockPath = `${discoveryFile}.lock`;
  await ensurePrivateDirectory(dirname(lockPath));

  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    try {
      await publishOwner(lockPath, owner);
      return { lockPath, owner };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    let existing: DaemonOwner;
    try {
      existing = await readOwner(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (isProcessAlive(existing.pid)) throw new CliOperationalError("already-running");

    const stalePath = `${lockPath}.stale.${randomBytes(8).toString("hex")}`;
    try {
      await rename(lockPath, stalePath);
      await unlink(stalePath).catch(() => undefined);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  throw new CliOperationalError("already-running");
}

export async function releaseDaemonOwnership(ownership: DaemonOwnership): Promise<void> {
  try {
    const current = await readOwner(ownership.lockPath);
    if (current.pid === ownership.owner.pid && current.startedAt === ownership.owner.startedAt) {
      await unlink(ownership.lockPath);
    }
  } catch {
    // Never delete ownership state that cannot be proven to belong to this process.
  }
}
