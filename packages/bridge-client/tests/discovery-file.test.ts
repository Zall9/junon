import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_DISCOVERY_FILE_BYTES,
  readPrivateDiscoveryFile,
} from "../src/discovery/discovery-file.js";

const temporaryDirectories: string[] = [];
const discovery = {
  protocolVersion: "0.1.0",
  endpoint: "ws://127.0.0.1:41731/rpc",
  token: "a".repeat(43),
  pid: 12345,
  startedAt: "2026-08-01T12:00:00Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(content = JSON.stringify(discovery), mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-client-discovery-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "discovery.json");
  await writeFile(filePath, content, { encoding: "utf8", mode });
  await chmod(filePath, mode);
  return filePath;
}

describe("client discovery", () => {
  it("reads a private, valid discovery file", async () => {
    await expect(readPrivateDiscoveryFile(await createFixture())).resolves.toEqual(discovery);
  });

  it("rejects group/world permissions", async () => {
    await expect(readPrivateDiscoveryFile(await createFixture(undefined, 0o644))).rejects.toThrow(
      "permissions",
    );
  });

  it("rejects symlinks without following them", async () => {
    const target = await createFixture();
    const link = `${target}.link`;
    await symlink(target, link);
    await expect(readPrivateDiscoveryFile(link)).rejects.toThrow();
  });

  it("rejects malformed and oversized files without echoing contents", async () => {
    const secret = "secret-that-must-not-be-reported";
    await expect(readPrivateDiscoveryFile(await createFixture(`{${secret}`))).rejects.not.toThrow(
      secret,
    );
    await expect(
      readPrivateDiscoveryFile(await createFixture("x".repeat(MAX_DISCOVERY_FILE_BYTES + 1))),
    ).rejects.toThrow("too large");
  });
});
