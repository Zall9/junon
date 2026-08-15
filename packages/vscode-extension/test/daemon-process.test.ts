import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnOwnedDaemon } from "../src/daemon-process.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

describe("owned daemon process", () => {
  it("stops only the exact child it spawned and is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-owned-daemon-"));
    directories.push(directory);
    const scriptPath = join(directory, "child.cjs");
    await writeFile(
      scriptPath,
      "process.once('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1000);\n",
      "utf8",
    );
    const child = spawnOwnedDaemon({
      scriptPath,
      discoveryFile: join(directory, "discovery.json"),
      logLevel: "info",
    });

    await Promise.all([child.stop(), child.stop()]);
    await expect(child.exited).resolves.toBeUndefined();
  });

  it("rejects a non-absolute child path before spawning", () => {
    expect(() =>
      spawnOwnedDaemon({
        scriptPath: "relative-child.js",
        discoveryFile: "/tmp/discovery.json",
        logLevel: "info",
      }),
    ).toThrow("path is invalid");
  });
});
