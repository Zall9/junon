import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertLoopbackDiscoveryEndpoint,
  writePrivateDiscoveryFile,
} from "../src/discovery/discovery-file.js";
import { generateAuthenticationToken } from "../src/security/authentication-token.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDiscoveryPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-discovery-"));
  temporaryDirectories.push(directory);
  return { directory, filePath: join(directory, "private", "discovery.json") };
}

describe("private discovery file", () => {
  it("writes an atomic 0600 file inside a 0700 directory", async () => {
    const { filePath } = await temporaryDiscoveryPath();
    const token = generateAuthenticationToken();
    const discovery = await writePrivateDiscoveryFile({
      filePath,
      endpoint: "ws://127.0.0.1:41731/rpc",
      token,
      pid: 12345,
      startedAt: new Date("2026-08-01T12:00:00Z"),
    });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(discovery);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
  });

  it("replaces a previous file without leaving temporary files", async () => {
    const { directory, filePath } = await temporaryDiscoveryPath();
    const firstToken = generateAuthenticationToken();
    const secondToken = generateAuthenticationToken();

    await writePrivateDiscoveryFile({
      filePath,
      endpoint: "ws://127.0.0.1:41731/rpc",
      token: firstToken,
    });
    await writePrivateDiscoveryFile({
      filePath,
      endpoint: "ws://127.0.0.1:41732/rpc",
      token: secondToken,
    });

    const stored = JSON.parse(await readFile(filePath, "utf8")) as { token: string };
    expect(stored.token).toBe(secondToken);
    expect(await readFile(filePath, "utf8")).not.toContain(firstToken);
    await expect(readdir(join(directory, "private"))).resolves.toEqual(["discovery.json"]);
  });

  it("rejects public, credentialed, malformed, and out-of-range endpoints", () => {
    for (const endpoint of [
      "ws://0.0.0.0:41731/rpc",
      "ws://user:password@127.0.0.1:41731/rpc",
      "ws://127.0.0.1:70000/rpc",
      "http://127.0.0.1:41731/rpc",
      "ws://127.0.0.1:41731/other",
    ]) {
      expect(() => assertLoopbackDiscoveryEndpoint(endpoint), endpoint).toThrow();
    }
  });

  it("rejects malformed authentication tokens", async () => {
    const { filePath } = await temporaryDiscoveryPath();
    await expect(
      writePrivateDiscoveryFile({
        filePath,
        endpoint: "ws://127.0.0.1:41731/rpc",
        token: "short",
      }),
    ).rejects.toThrow("authentication token");
  });

  it("refuses a symbolic-link discovery directory", async () => {
    const { directory } = await temporaryDiscoveryPath();
    const realDirectory = join(directory, "real");
    const linkedDirectory = join(directory, "linked");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);

    await expect(
      writePrivateDiscoveryFile({
        filePath: join(linkedDirectory, "discovery.json"),
        endpoint: "ws://127.0.0.1:41731/rpc",
        token: generateAuthenticationToken(),
      }),
    ).rejects.toThrow("symbolic link");
  });
});
