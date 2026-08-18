import { DAEMON_VERSION } from "@ide-bridge/bridge-daemon";
import { describe, expect, it } from "vitest";

import { versionCheck } from "../src/doctor.js";

/**
 * The half that could not be wrong.
 *
 * Every version comparison here measured peers *against* the daemon, which made the daemon correct by
 * construction: a 0.2.1 daemon serving 0.2.1 plugins reported "all at 0.2.1" while the rest of the
 * installation had moved on. It happened during this release — the daemon was restarted without being
 * rebuilt, and no surface said a word.
 *
 * The reference it lacked is this CLI, which ships in the same release and knows its own version
 * without asking anyone.
 */
function connectionReporting(daemonVersion: string, adapters: { version: string; ideVersion: string }[]) {
  return {
    request: async (method: string) =>
      method === "bridge/getStatus" ? { daemonVersion } : { adapters },
  } as never;
}

describe("the versions check", () => {
  const adapter = { version: DAEMON_VERSION, ideVersion: "PS-253.32098.40" };

  it("names the daemon when it is older than the CLI talking to it", async () => {
    const check = await versionCheck(connectionReporting("0.0.1", [adapter]));

    expect(check.status).toBe("warn");
    expect(check.detail).toContain(`daemon-0.0.1-older-than-this-cli-${DAEMON_VERSION}`);
    // Rebuilding without restarting is the mistake this sentence exists to prevent.
    expect(check.detail).toContain("pnpm -r build");
    expect(check.detail).toContain("a rebuild alone changes nothing");
  });

  it("does not blame the adapters when the daemon is the stale one", async () => {
    // An adapter newer than a stale daemon is not a plugin problem, and telling someone to reinstall
    // it would send them the wrong way.
    const check = await versionCheck(connectionReporting("0.0.1", [adapter]));

    expect(check.detail).not.toContain("install-jetbrains-plugin");
  });

  it("passes when the daemon matches this CLI and every adapter matches it", async () => {
    const check = await versionCheck(connectionReporting(DAEMON_VERSION, [adapter]));

    expect(check.status).toBe("pass");
    expect(check.detail).toBe(`all-at-${DAEMON_VERSION}`);
  });

  it("skips rather than guessing when no adapter is connected", async () => {
    const check = await versionCheck(connectionReporting(DAEMON_VERSION, []));

    expect(check.status).toBe("skip");
  });
});
