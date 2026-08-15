import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor.js";

const TOKEN = "9h7EaMNxtmJg7AHKQQqCawnLdbUiyE0QuauxK6fAJx8";

async function discoveryFile(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ide-bridge-doctor-"));
  const path = join(directory, "discovery.json");
  await writeFile(
    path,
    JSON.stringify({
      protocolVersion: "0.1.0",
      // Port 1 is never a daemon, so every run reaches the unreachable branch deterministically.
      endpoint: "ws://127.0.0.1:1/rpc",
      token: TOKEN,
      pid: process.pid,
      startedAt: "2026-08-11T13:45:41.184Z",
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}

describe("ide-bridge doctor", () => {
  // Every check in this report passed, for three days, against a daemon started days earlier from a
  // build nobody had rebuilt. Alive, reachable, protocol-compatible, and the wrong process. The
  // checks cannot catch that; naming which daemon answered can (ADR-0037).
  it("names the daemon behind the discovery file, and how long it has been running", async () => {
    const path = await discoveryFile();

    const report = await runDoctor(path, { now: () => new Date("2026-08-14T13:45:41.184Z") });

    expect(report.daemon).toEqual({
      discoveryFile: path,
      pid: process.pid,
      startedAt: "2026-08-11T13:45:41.184Z",
      uptimeSeconds: 3 * 24 * 60 * 60,
    });
  });

  // A diagnostic is pasted into issues and chat windows. The discovery file it reads holds the
  // daemon's authentication token, and repeating it here would turn a support paste into a leak.
  it("repeats nothing secret from the file it read", async () => {
    const path = await discoveryFile();

    const report = await runDoctor(path, { now: () => new Date("2026-08-14T13:45:41.184Z") });

    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain("127.0.0.1:1");
  });

  it("reports no daemon when the discovery file cannot be read", async () => {
    const report = await runDoctor(join(tmpdir(), "ide-bridge-doctor-absent", "discovery.json"));

    expect(report.ok).toBe(false);
    expect(report.daemon).toBeUndefined();
  });

  it("declines to compute an uptime it cannot derive", async () => {
    const path = await discoveryFile({ startedAt: "not-a-timestamp" });

    const report = await runDoctor(path, { now: () => new Date("2026-08-14T13:45:41.184Z") });

    // Either the file is refused outright as malformed, or it is read and the uptime is absent —
    // never a plausible-looking number derived from a timestamp nobody could parse.
    expect(report.daemon?.uptimeSeconds).toBeUndefined();
  });
});
