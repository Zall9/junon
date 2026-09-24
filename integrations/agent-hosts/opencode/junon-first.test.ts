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

/** The call opencode 2 would run after the hook: the event, as the hook left it. */
async function afterV2(tool: string, session: string, input: Record<string, unknown>) {
  const event = { tool, sessionID: session, input, id: "c" };
  await v2(event as never);
  return event as { tool: string; input: Record<string, unknown> };
}

/** Runs an outline program the way `execute` does: an async body with `tools` and `search` in scope. */
async function runOutline(code: string, tools: Record<string, unknown>): Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (tools: unknown, search: unknown) => Promise<string>;
  return new AsyncFunction("tools", "search", code)(tools, async () => ({ items: [] }));
}

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
    // opencode 2's own instructions: `search` is synchronous, "call it without await".
    expect(refusal).toMatch(/`search\(\{ query: "serena" \}\)` finds it/);
    expect(refusal).not.toMatch(/serena_find_symbol/);
  });

  it("the argument an IDE tool takes is relative_path, relative to the project", async () => {
    const refusal = await asV1("read", "v1-large", { filePath: largeFile }).catch((error: Error) => error.message);

    expect(refusal).toMatch(/serena_ide_symbols_overview\(\{ relative_path: "src-large\.ts" \}\)/);
    expect(refusal).not.toMatch(/\{ path:/);
  });
});

describe("each host's own argument and tool names", () => {
  it("opencode 1 reads with filePath, opencode 2 with path — both are gated", async () => {
    await expect(asV1("read", "v1-path", { filePath: largeFile })).rejects.toThrow(/was not run/);
    expect((await afterV2("read", "v2-path", { path: largeFile })).tool).toBe("execute");
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

describe("a whole read of a large source file is never let through", () => {
  // Measured 2026-09-24: repeating the call was the cheapest way around the gate, and eight of the
  // ten sessions that never used serena were ones the gate had given up on.
  it("opencode 1 refuses it on every try, and a range always passes", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(asV1("read", "v1-strict", { filePath: largeFile })).rejects.toThrow(/will not be on another try/);
    }
    await expect(asV1("read", "v1-strict", { filePath: largeFile, offset: 1, limit: 80 })).resolves.toBeUndefined();
  });

  it("opencode 2 answers it with the outline on every try, and leaves a range alone", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const call = await afterV2("read", "v2-strict", { path: largeFile });
      expect(call.tool).toBe("execute");
      expect(String(call.input.code)).toContain('const relative = "src-large.ts"');
    }
    const ranged = await afterV2("read", "v2-strict", { path: largeFile, offset: 1, limit: 80 });
    expect(ranged).toMatchObject({ tool: "read", input: { path: largeFile, offset: 1, limit: 80 } });
  });

  it("does not give up on a session that ignored the other nudges", async () => {
    // Three ignored refusals switch the guesses off for a session that never used serena. The
    // large-file rule is not a guess, and a range is always there to take instead.
    for (const pattern of ["alphaThing", "betaThing", "gammaThing", "deltaThing"]) {
      await asV1("grep", "v1-given-up", { pattern }).catch(() => undefined);
    }
    await expect(asV1("grep", "v1-given-up", { pattern: "epsilonThing" })).resolves.toBeUndefined();
    await expect(asV1("read", "v1-given-up", { filePath: largeFile })).rejects.toThrow(/was not run/);
    await expect(asV1("bash", "v1-given-up", { command: `cat ${largeFile}` })).rejects.toThrow(/was not run/);
  });

  it("leaves a file outside the project alone — JUNON has nothing to say about it", async () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), "junon-gate-elsewhere-")), "outside.ts");
    writeFileSync(elsewhere, "export const line = 1\n".repeat(400));

    await expect(asV1("read", "v1-outside", { filePath: elsewhere })).resolves.toBeUndefined();
    expect(await afterV2("read", "v2-outside", { path: elsewhere })).toMatchObject({ tool: "read" });
    await expect(asV2("shell", "v2-outside", { command: `cat ${elsewhere}` })).resolves.toBeUndefined();
  });

  it("resolves a path relative to the project", async () => {
    expect((await afterV2("read", "v2-relative", { path: "src-large.ts" })).tool).toBe("execute");
  });
});

describe("the shell reads a whole file the same way", () => {
  it("cat, nl and friends of a large file are refused on every try, under both hosts", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(asV1("bash", "v1-cat", { command: `cat ${largeFile}` })).rejects.toThrow(/will not be on another try/);
      await expect(asV2("shell", "v2-cat", { command: "cat src-large.ts" })).rejects.toThrow(/will not be on another try/);
    }
    await expect(asV2("shell", "v2-nl", { command: `cd /tmp && nl ${largeFile}` })).rejects.toThrow(/prints/);
  });

  it("a range or a pipeline is not a whole read", async () => {
    await expect(asV2("shell", "v2-range", { command: `sed -n '1,80p' ${largeFile}` })).resolves.toBeUndefined();
    await expect(asV2("shell", "v2-head", { command: `head -50 ${largeFile}` })).resolves.toBeUndefined();
    await expect(asV2("shell", "v2-pipe", { command: `cat ${largeFile} | wc -l` })).resolves.toBeUndefined();
  });

  it("a grep fed by a pipe filters output, not source files", async () => {
    await expect(asV2("shell", "v2-filter", { command: "git log --oneline | grep startWorkflow" })).resolves.toBeUndefined();
    // Control: the same grep over the files is still a question about a symbol.
    await expect(asV2("shell", "v2-filter", { command: "grep -rn startWorkflow src" })).rejects.toThrow(/was not run/);
  });

  it("a regex alternation inside quotes is one pattern, not a pipe", async () => {
    await expect(asV2("shell", "v2-alternation", { command: 'grep -rnE "startWorkflow|compose" src' })).resolves.toBeUndefined();
    await expect(asV2("shell", "v2-alternation", { command: "grep -iE 'tool|error' server.log" })).resolves.toBeUndefined();
  });

  it("a grep aimed outside the project is left alone", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "junon-gate-grep-"));
    await expect(asV2("grep", "v2-grep-outside", { pattern: "startWorkflow", path: elsewhere })).resolves.toBeUndefined();
    await expect(asV2("grep", "v2-grep-inside", { pattern: "startWorkflow", path: project })).rejects.toThrow(/was not run/);
  });
});

describe("the outline opencode 2 runs instead", () => {
  const symbols = {
    symbols: [
      {
        locator: { name: "Ledger", kind: "class" },
        range: { start: { line: 0 }, end: { line: 304 } },
        children: [{ locator: { name: "entry0", kind: "method" }, range: { start: { line: 2 }, end: { line: 5 } }, children: [] }],
      },
    ],
  };
  const program = async () => String((await afterV2("read", "v2-program", { path: largeFile })).input.code);

  it("lists the IDE's declarations with their lines, one level deep", async () => {
    const answer = await runOutline(await program(), {
      serena: { ide_symbols_overview: async () => ({ result: JSON.stringify(symbols) }) },
    });

    expect(answer).toContain("answered with its outline by JUNON");
    expect(answer).toContain("1-305  class Ledger");
    expect(answer).toContain("  3-6  method entry0");
  });

  it("falls back to serena's language server when the IDE explains instead of answering", async () => {
    const answer = await runOutline(await program(), {
      serena: {
        ide_symbols_overview: async () => ({ result: "No IDE has this project open." }),
        get_symbols_overview: async () => ({ result: JSON.stringify({ Class: ["Ledger"] }) }),
      },
    });

    expect(answer).toContain("From serena's language server");
    expect(answer).toContain('{"Class":["Ledger"]}');
  });

  it("answers with the refusal, as the read's result, when serena is not configured", async () => {
    const answer = await runOutline(await program(), { browser: {} });

    expect(answer).toMatch(/was not run/);
    expect(answer).toContain("serena is not in this turn's tool catalog");
    expect(answer).not.toContain("answered with its outline");
  });

  it("does the same when serena is missing from the turn's catalog, which shows only when called", async () => {
    // Measured in opencode 2's sandbox: a session's first turn can lack serena while it is connected,
    // and `tools.serena` still exists — calling through it throws "Unknown tool".
    const missing = new Proxy(
      {},
      {
        get: (_target, name) => async () => {
          throw new Error(`Unknown tool 'serena.${String(name)}'. Did you mean tools.browser.files.get?`);
        },
      },
    );
    const answer = await runOutline(await program(), { browser: {}, serena: missing });

    expect(answer).toMatch(/was not run/);
    expect(answer).toContain("serena is not in this turn's tool catalog");
  });

  it("says what each one answered when neither can outline it", async () => {
    const answer = await runOutline(await program(), {
      serena: {
        ide_symbols_overview: async () => ({ result: "No IDE has this project open." }),
        get_symbols_overview: async () => {
          throw new Error("language server terminated");
        },
      },
    });

    expect(answer).toMatch(/was not run/);
    expect(answer).toContain("the IDE: No IDE has this project open.");
    expect(answer).toContain("serena: Error: language server terminated");
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
