import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareReleases, runDoctor } from "../src/doctor.js";

/**
 * The check that says one half of this installation is older than the other.
 *
 * No distribution channel can say it. An IDE updates its plugin without knowing a daemon exists;
 * `pipx` updates JUNON without knowing either. The daemon holds every peer's declared version and
 * its own, and until this check it compared none of them — which is why a plugin two releases behind
 * looked exactly like a plugin that was current.
 */
describe("release ordering", () => {
  it("orders releases", () => {
    expect(compareReleases("0.1.0", "0.2.0")).toBe(-1);
    expect(compareReleases("0.2.0", "0.1.0")).toBe(1);
    expect(compareReleases("0.2.0", "0.2.0")).toBe(0);
    expect(compareReleases("0.9.0", "0.10.0")).toBe(-1); // not string order
    expect(compareReleases("1.0.0", "0.99.99")).toBe(1);
  });

  it("has no opinion about a version it cannot parse", () => {
    // `0.1.0-SNAPSHOT` is what this plugin built as until today. Reading it as "older" would send
    // someone to reinstall over a suffix; reading it as "newer" would hide a real skew. Neither is
    // an answer, so the check says nothing rather than something false.
    expect(compareReleases("0.1.0-SNAPSHOT", "0.2.0")).toBe(0);
    expect(compareReleases("0.2.0", "")).toBe(0);
    expect(compareReleases("nightly", "0.2.0")).toBe(0);
  });
});

describe("the doctor report", () => {
  it("carries a versions check even when nothing can be reached", async () => {
    // Skipped rather than absent: a report whose shape changes with the failure makes a consumer
    // guess whether the check exists at all.
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-versions-"));
    const path = join(directory, "discovery.json");
    await writeFile(path, "not json", { mode: 0o600 });

    const report = await runDoctor(path);

    const versions = report.checks.find(({ name }) => name === "versions");
    expect(versions).toBeDefined();
    expect(versions?.status).toBe("skip");
  });
});
