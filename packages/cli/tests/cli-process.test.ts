import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function runCommand(args: string[]): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [binPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

async function waitForLine(stream: NodeJS.ReadableStream): Promise<string> {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += String(chunk);
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
  throw new Error("Process ended before emitting a line");
}

describe("ide-bridge CLI process integration", () => {
  it("owns a real daemon and serves every administration command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-cli-process-"));
    temporaryDirectories.push(directory);
    const discoveryFile = join(directory, "private", "discovery.json");
    const daemon = spawn(
      process.execPath,
      [binPath, "daemon", "--discovery-file", discoveryFile, "--log-level", "info"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(daemon);
    let daemonStderr = "";
    daemon.stderr.on("data", (chunk: Buffer) => (daemonStderr += chunk.toString()));
    const ready = JSON.parse(await waitForLine(daemon.stdout)) as Record<string, unknown>;
    expect(ready).toMatchObject({ ok: true, command: "daemon", status: "ready" });

    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { token: string };
    expect((await stat(discoveryFile)).mode & 0o777).toBe(0o600);
    expect((await stat(`${discoveryFile}.lock`)).mode & 0o777).toBe(0o600);

    const status = await runCommand(["status", "--discovery-file", discoveryFile]);
    expect(status).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      command: "status",
      result: { adapterCount: 0, workspaceCount: 0 },
    });

    const adapters = await runCommand(["adapters", "--discovery-file", discoveryFile]);
    expect(JSON.parse(adapters.stdout)).toEqual({
      ok: true,
      command: "adapters",
      result: { adapters: [] },
    });
    const workspaces = await runCommand(["workspaces", "--discovery-file", discoveryFile]);
    expect(JSON.parse(workspaces.stdout)).toEqual({
      ok: true,
      command: "workspaces",
      result: { workspaces: [] },
    });

    const doctor = await runCommand(["doctor", "--discovery-file", discoveryFile]);
    expect(doctor.code).toBe(0);
    const doctorReport = JSON.parse(doctor.stdout) as {
      ok: boolean;
      command: string;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(doctorReport).toMatchObject({ ok: true, command: "doctor" });
    expect(doctorReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "permissions",
          status: "pass",
          detail: "mode-0600",
        }),
        expect.objectContaining({ name: "port", status: "pass" }),
        expect.objectContaining({ name: "protocol", status: "pass" }),
        expect.objectContaining({
          name: "adapters",
          status: "warn",
          detail: "no-adapter-registered",
        }),
        expect.objectContaining({ name: "sessions-expired", status: "pass" }),
      ]),
    );

    const duplicate = await runCommand([
      "daemon",
      "--discovery-file",
      discoveryFile,
      "--log-level",
      "silent",
    ]);
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.stderr)).toEqual({
      ok: false,
      command: "daemon",
      error: "already-running",
    });

    daemon.kill("SIGTERM");
    const [exitCode, signal] = (await once(daemon, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null });
    expect(daemonStderr).toContain('"event":"daemon.started"');
    expect(daemonStderr).toContain('"event":"daemon.stopped"');
    expect(daemonStderr).not.toContain(discovery.token);
    await expect(stat(discoveryFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${discoveryFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(dirname(discoveryFile)).toBe(join(directory, "private"));
    // Six real Node processes — a daemon plus five CLI invocations — each paying interpreter
    // startup. The default 5s budget is spent on process spawning rather than on anything this
    // test asserts, so it fails under load while the behaviour is correct. What is being checked
    // is daemon ownership and command output, never latency.
  }, 30_000);

  it("uses stable usage and doctor failure exit codes without raw errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ide-bridge-cli-errors-"));
    temporaryDirectories.push(directory);
    const discoveryFile = join(directory, "missing.json");
    const usage = await runCommand(["unknown"]);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stderr)).toEqual({
      ok: false,
      error: "usage",
      detail: "unknown-command",
    });
    const doctor = await runCommand(["doctor", "--discovery-file", discoveryFile]);
    expect(doctor.code).toBe(1);
    const report = JSON.parse(doctor.stdout) as { checks: { name: string }[] };
    // Every check reports, including the ones that could not run: a report whose shape changes with
    // the failure makes a reader guess whether a check exists at all.
    expect(report.checks.map(({ name }) => name)).toEqual([
      "discovery-file",
      "permissions",
      "daemon-process",
      "port",
      "protocol",
      "adapters",
      "versions",
      "sessions-expired",
    ]);
    expect(doctor.stdout).not.toContain(discoveryFile);
    expect(doctor.stderr).toBe("");
    const status = await runCommand(["status", "--discovery-file", discoveryFile]);
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stderr)).toEqual({
      ok: false,
      command: "status",
      error: "discovery-unavailable",
    });
    expect(status.stderr).not.toContain(discoveryFile);
  });
});
