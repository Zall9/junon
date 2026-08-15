import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliOperationalError } from "../src/errors.js";
import { acquireDaemonOwnership, releaseDaemonOwnership } from "../src/ownership.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryDiscoveryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-cli-owner-"));
  temporaryDirectories.push(directory);
  return join(directory, "private", "discovery.json");
}

describe("daemon ownership", () => {
  it("publishes a private lock, rejects a live owner, and releases only itself", async () => {
    const discoveryFile = await temporaryDiscoveryPath();
    const owner = { pid: process.pid, startedAt: "2026-08-01T12:00:00.000Z" };
    const ownership = await acquireDaemonOwnership(discoveryFile, owner);
    expect(JSON.parse(await readFile(ownership.lockPath, "utf8"))).toEqual(owner);
    expect((await stat(ownership.lockPath)).mode & 0o777).toBe(0o600);
    await expect(
      acquireDaemonOwnership(discoveryFile, {
        pid: process.pid,
        startedAt: "2026-08-01T12:00:01.000Z",
      }),
    ).rejects.toMatchObject<CliOperationalError>({ code: "already-running" });
    await releaseDaemonOwnership(ownership);
    await expect(stat(ownership.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically recovers a valid dead owner", async () => {
    const discoveryFile = await temporaryDiscoveryPath();
    const lockPath = `${discoveryFile}.lock`;
    const first = await acquireDaemonOwnership(discoveryFile, {
      pid: 2_147_483_647,
      startedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(first.lockPath).toBe(lockPath);
    const replacement = await acquireDaemonOwnership(discoveryFile, {
      pid: process.pid,
      startedAt: "2026-08-01T12:00:01.000Z",
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement.owner);
    await releaseDaemonOwnership(replacement);
  });

  it("refuses malformed or insecure ownership state without exposing its contents", async () => {
    const discoveryFile = await temporaryDiscoveryPath();
    const lockPath = `${discoveryFile}.lock`;
    const initial = await acquireDaemonOwnership(discoveryFile, {
      pid: 2_147_483_647,
      startedAt: "2026-08-01T12:00:00.000Z",
    });
    await writeFile(lockPath, '{"token":"owner-secret"}', "utf8");
    await chmod(lockPath, 0o644);
    let rejection: unknown;
    try {
      await acquireDaemonOwnership(discoveryFile, {
        pid: process.pid,
        startedAt: "2026-08-01T12:00:01.000Z",
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject<CliOperationalError>({ code: "ownership-invalid" });
    expect(String(rejection)).not.toContain("owner-secret");
    await releaseDaemonOwnership(initial);
  });
});
