/**
 * The gate, through each host's own entry point — the way opencode 1 and opencode 2 actually call it.
 *
 * opencode 1 takes the default export's `server` and runs its `tool.execute.before`; opencode 2 takes
 * its `setup` and registers through `ctx.tool.hook` — both measured with a traced copy under each. The two expose MCP tools
 * differently, measured on 2026-09-23 in the user's own sessions: opencode 1 as tools named
 * `serena_find_symbol`, opencode 2 only through the `execute` meta-tool, as
 * `await tools.serena.find_symbol({...})`. Advice has to be callable by whoever reads it.
 *
 * The gate keeps its state per process, as it does inside a host, so every test uses its own
 * session id rather than resetting anything.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import * as gateModule from "./junon-first.ts";

const plugin = gateModule.default;

type Hook = (event: { tool: string; sessionID: string; input: unknown }) => Promise<void>;

let project: string;
let smallFile: string;
let largeFile: string;
let v1: Awaited<ReturnType<typeof plugin.server>>;
let v2: Hook;

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), "junon-gate-"));
  smallFile = join(project, "small.ts");
  largeFile = join(project, "src-large.ts");
  writeFileSync(smallFile, "export const a = 1\n");
  writeFileSync(largeFile, "export const line = 1\n".repeat(400));

  v1 = await plugin.server({ directory: project });

  let captured: Hook | undefined;
  await plugin.setup({
    location: { directory: project },
    tool: {
      async hook(_name, callback) {
        captured = callback as Hook;
        return { dispose: async () => {} };
      },
    },
  });
  if (!captured) throw new Error("opencode 2's setup registered no hook");
  v2 = captured;
});

const asV1 = (tool: string, session: string, args: Record<string, unknown>, callID = "c") =>
  v1["tool.execute.before"]({ tool, sessionID: session, callID }, { args });
const asV2 = (tool: string, session: string, input: Record<string, unknown>, id = "c") =>
  v2({ tool, sessionID: session, input, id } as never);

describe("one file, loadable by both hosts", () => {
  it("one default export: `server` for opencode 1, `setup` for opencode 2, and nothing else", () => {
    // opencode 1.18 ignores named exports once a default exists, so a named plugin here would be
    // dead code at best — and, on a host that read both, a second registration.
    expect(Object.keys(gateModule)).toEqual(["default"]);
    expect(plugin.id).toBe("junon-first");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });
});

describe("advice is written in the asking host's dialect", () => {
  it("opencode 1 is told the tool names it has", async () => {
    await expect(asV1("grep", "v1-grep", { pattern: "compose" })).rejects.toThrow(
      /serena_find_symbol\(\{ name_path_pattern: "compose" \}\)/,
    );
  });

  it("opencode 2 is told to go through execute, never a serena_ tool it does not have", async () => {
    const refusal = await asV2("grep", "v2-grep", { pattern: "compose" }).catch((error: Error) => error.message);

    expect(refusal).toMatch(/execute → await tools\.serena\.find_symbol\(\{ name_path_pattern: "compose" \}\)/);
    expect(refusal).toMatch(/await search\(\{ query: "serena" \}\)/);
    expect(refusal).not.toMatch(/serena_find_symbol/);
  });

  it("the argument an IDE read takes is relative_path, relative to the project", async () => {
    const refusal = await asV2("read", "v2-large", { path: largeFile }).catch((error: Error) => error.message);

    expect(refusal).toMatch(/tools\.serena\.ide_read_document\(\{ relative_path: "src-large\.ts" \}\)/);
    expect(refusal).not.toMatch(/ide_read_document\(\{ path:/);
  });
});

describe("each host's own argument and tool names", () => {
  it("opencode 1 reads with filePath, opencode 2 with path — both are gated", async () => {
    await expect(asV1("read", "v1-path", { filePath: largeFile })).rejects.toThrow(/was not run/);
    await expect(asV2("read", "v2-path", { path: largeFile })).rejects.toThrow(/was not run/);
  });

  it("the shell is bash in opencode 1 and shell in opencode 2 — both are gated", async () => {
    await expect(asV1("bash", "v1-shell", { command: "grep -rn compose src" })).rejects.toThrow(/was not run/);
    await expect(asV2("shell", "v2-shell", { command: "grep -rn compose src" })).rejects.toThrow(/was not run/);
  });

  it("a range is never refused", async () => {
    await expect(asV2("read", "v2-range", { path: largeFile, offset: 10, limit: 20 })).resolves.toBeUndefined();
  });
});

describe("the same call a second time runs, under both hosts", () => {
  it("refuses once and then lets the agent decide", async () => {
    await expect(asV1("grep", "v1-twice", { pattern: "startWorkflow" })).rejects.toThrow();
    await expect(asV1("grep", "v1-twice", { pattern: "startWorkflow" })).resolves.toBeUndefined();
    await expect(asV2("grep", "v2-twice", { pattern: "startWorkflow" })).rejects.toThrow();
    await expect(asV2("grep", "v2-twice", { pattern: "startWorkflow" })).resolves.toBeUndefined();
  });
});

describe("a session that uses serena is recognised under both hosts", () => {
  // The small-file nudge is only for a session that has never asked the index anything, which makes
  // it the observable proof of whether the gate recognised a symbolic call.
  it("control: a session that has not used serena is nudged about a short file", async () => {
    await expect(asV2("read", "v2-unproven", { path: smallFile })).rejects.toThrow(/has not asked the index/);
  });

  it("opencode 2: an execute calling tools.serena counts", async () => {
    await asV2("execute", "v2-proven", { code: 'return await tools.serena.find_symbol({ name_path_pattern: "x" })' });
    await expect(asV2("read", "v2-proven", { path: smallFile })).resolves.toBeUndefined();
  });

  it('opencode 2: the bracket form tools["serena"] counts too', async () => {
    await asV2("execute", "v2-bracket", { code: 'return await tools["serena"].list_memories({})' });
    await expect(asV2("read", "v2-bracket", { path: smallFile })).resolves.toBeUndefined();
  });

  it("opencode 2: an execute that never touches serena does not", async () => {
    await asV2("execute", "v2-other", { code: 'return await tools["basic-memory-remote"].search_notes({ query: "x" })' });
    await expect(asV2("read", "v2-other", { path: smallFile })).rejects.toThrow(/has not asked the index/);
  });

  it("opencode 1: a serena_ tool call counts, as it always did", async () => {
    await asV1("serena_find_symbol", "v1-proven", { name_path_pattern: "x" });
    await expect(asV1("read", "v1-proven", { filePath: smallFile })).resolves.toBeUndefined();
  });
});

describe("every call is judged, whatever its id", () => {
  // Models that number tool calls per message — Kimi's `functions.grep:0` — reuse the same id on
  // every turn. De-duplicating by call id would silently switch the gate off after the first one.
  it("two different calls sharing an id are both refused", async () => {
    await expect(asV1("grep", "v1-kimi", { pattern: "alphaSymbol" }, "functions.grep:0")).rejects.toThrow();
    await expect(asV1("grep", "v1-kimi", { pattern: "betaSymbol" }, "functions.grep:0")).rejects.toThrow();
    await expect(asV2("grep", "v2-kimi", { pattern: "alphaSymbol" }, "functions.grep:0")).rejects.toThrow();
    await expect(asV2("grep", "v2-kimi", { pattern: "betaSymbol" }, "functions.grep:0")).rejects.toThrow();
  });
});
