/**
 * `doctor`'s agent-gates check: whether the gate each agent host loads is this checkout's.
 *
 * It reads the same manifest JUNON installs from (integrations/agent-hosts/manifest.json), so the
 * installer and this check cannot disagree about what a complete installation is. Read-only.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentGateCheck } from "../src/doctor.js";

async function fixture(): Promise<{ home: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-gates-"));
  const source = join(root, "source");
  const home = join(root, "home");
  await mkdir(join(source, "opencode"), { recursive: true });
  await writeFile(join(source, "opencode", "junon-first.ts"), "// this release\n");
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      files: [
        {
          source: "opencode/junon-first.ts",
          target: ".config/opencode/plugin/junon-first.ts",
          host: ".config/opencode",
        },
      ],
      strays: [{ path: ".config/opencode/plugins/junon-first.ts" }],
    }),
  );
  await mkdir(join(home, ".config", "opencode", "plugin"), { recursive: true });
  return { home, source };
}

describe("agent-gates", () => {
  it("passes when the installed gate is this checkout's", async () => {
    const { home, source } = await fixture();
    await writeFile(join(home, ".config/opencode/plugin/junon-first.ts"), "// this release\n");

    expect(await agentGateCheck({ home, source })).toEqual({
      name: "agent-gates",
      status: "pass",
      detail: "current",
    });
  });

  it("warns, naming the file and the remedy, when it differs", async () => {
    const { home, source } = await fixture();
    await writeFile(join(home, ".config/opencode/plugin/junon-first.ts"), "// an older release\n");

    const check = await agentGateCheck({ home, source });

    expect(check.status).toBe("warn");
    expect(check.detail).toContain(".config/opencode/plugin/junon-first.ts differs");
    expect(check.detail).toContain("scripts/install-agent-gate.sh");
  });

  it("warns when it is missing from a configured host", async () => {
    const { home, source } = await fixture();

    const check = await agentGateCheck({ home, source });

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("missing");
  });

  it("warns about a second copy, which opencode would load as a second plugin", async () => {
    const { home, source } = await fixture();
    await writeFile(join(home, ".config/opencode/plugin/junon-first.ts"), "// this release\n");
    await mkdir(join(home, ".config/opencode/plugins"), { recursive: true });
    await writeFile(join(home, ".config/opencode/plugins/junon-first.ts"), "// this release\n");

    const check = await agentGateCheck({ home, source });

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("second copy");
  });

  it("skips a machine with no agent host configured, which is not a finding", async () => {
    const { source } = await fixture();
    const bare = await mkdtemp(join(tmpdir(), "agent-gates-bare-"));

    expect(await agentGateCheck({ home: bare, source })).toMatchObject({
      status: "skip",
      detail: "no-agent-host-configured",
    });
  });

  it("skips outside a checkout rather than failing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "agent-gates-none-"));

    expect(await agentGateCheck({ home: empty, source: join(empty, "nowhere") })).toMatchObject({
      status: "skip",
      detail: "not-running-from-a-checkout",
    });
  });

  it("finds this repository's own manifest by default", async () => {
    const empty = await mkdtemp(join(tmpdir(), "agent-gates-home-"));

    // An empty home configures no host: the skip proves the manifest was found and read, since a
    // missing manifest would say not-running-from-a-checkout instead.
    expect(await agentGateCheck({ home: empty })).toMatchObject({
      detail: "no-agent-host-configured",
    });
  });
});
