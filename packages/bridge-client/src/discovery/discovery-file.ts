import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  PROTOCOL_VERSION,
  parseIDEBPDiscoveryFile,
  type IDEBPDiscoveryFile,
} from "@ide-bridge/protocol";

export const MAX_DISCOVERY_FILE_BYTES = 16 * 1024;

export async function readPrivateDiscoveryFile(filePath: string): Promise<IDEBPDiscoveryFile> {
  if (process.platform === "win32") {
    throw new Error("Private discovery-file ACL validation is not implemented on Windows");
  }

  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Discovery path is not a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new Error("Discovery file permissions are too broad");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Discovery file is not owned by the current user");
    }
    if (metadata.size > MAX_DISCOVERY_FILE_BYTES) throw new Error("Discovery file is too large");

    const bytes = Buffer.alloc(MAX_DISCOVERY_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_DISCOVERY_FILE_BYTES) throw new Error("Discovery file is too large");
    const serialized = bytes.subarray(0, bytesRead).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("Discovery file is not valid JSON");
    }

    const discovery = parseIDEBPDiscoveryFile(value);
    if (discovery.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Discovery protocol version is incompatible with this client");
    }
    return discovery;
  } finally {
    await handle.close();
  }
}
