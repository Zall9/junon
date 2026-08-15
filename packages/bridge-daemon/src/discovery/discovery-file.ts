import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { assertIDEBPLoopbackEndpoint, PROTOCOL_VERSION } from "@ide-bridge/protocol";
import type { IDEBPDiscoveryFile } from "@ide-bridge/protocol";

import { isAuthenticationToken } from "../security/authentication-token.js";

export interface WriteDiscoveryFileOptions {
  filePath: string;
  endpoint: string;
  token: string;
  pid?: number;
  startedAt?: Date;
}

export function assertLoopbackDiscoveryEndpoint(endpoint: string): void {
  assertIDEBPLoopbackEndpoint(endpoint);
}

export async function writePrivateDiscoveryFile(
  options: WriteDiscoveryFileOptions,
): Promise<IDEBPDiscoveryFile> {
  if (process.platform === "win32") {
    throw new Error("Private discovery-file ACLs are not implemented on Windows");
  }
  assertLoopbackDiscoveryEndpoint(options.endpoint);
  if (!isAuthenticationToken(options.token)) {
    throw new Error("Discovery token is not a valid base64url authentication token");
  }

  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Discovery pid must be positive");
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  const discovery: IDEBPDiscoveryFile = {
    protocolVersion: PROTOCOL_VERSION,
    endpoint: options.endpoint,
    token: options.token,
    pid,
    startedAt,
  };

  const directory = dirname(options.filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("Discovery directory must be a real directory, not a symbolic link");
  }
  await chmod(directory, 0o700);

  const temporaryPath = join(
    directory,
    `.${basename(options.filePath)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(discovery, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, options.filePath);
    published = true;
    await chmod(options.filePath, 0o600);
    const fileMode = (await stat(options.filePath)).mode & 0o777;
    if (fileMode !== 0o600) throw new Error("Discovery file permissions are not private");
    return discovery;
  } catch (error) {
    await unlink(published ? options.filePath : temporaryPath).catch(() => undefined);
    throw error;
  }
}
