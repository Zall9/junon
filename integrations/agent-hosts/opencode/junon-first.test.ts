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

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as gateModule from "./junon-first.ts";

const plugin = gateModule.default;

type Hook = (event: { tool: string; sessionID: string; input: unknown; [key: string]: unknown }) => Promise<void>;

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

  // This opencode 2 has no `tool.transform`, as an early 2.0 would not: nothing is promoted, and the
  // advice keeps naming `execute`. `withRegistry` below builds one that has it.
  const hooks: Record<string, Hook> = {};
  await plugin.setup({
    location: { directory: project },
    tool: {
      async hook(name, callback) {
        hooks[name] = callback as Hook;
        return { dispose: async () => {} };
      },
    },
  });
  if (!hooks["execute.before"]) throw new Error("opencode 2's setup registered no execute.before hook");
  v2 = hooks["execute.before"];
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

/** What the model reads back from a call answered by the plugin: what its `execute` returns. */
async function answerOf(event: { input: Record<string, unknown> }): Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => () => Promise<string>;
  return new AsyncFunction(String(event.input.code))();
}

/** A serena tool's answer, the shape opencode 2's registry returns it in. */
const reply = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

type SerenaTool = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * A fresh copy of the plugin, set up by an opencode 2 whose registry holds `read`, `grep` and the
 * serena tools given — each module load has its own state, as each host process does.
 */
async function withRegistry(serena: Record<string, SerenaTool>) {
  vi.resetModules();
  const fresh = (await import("./junon-first.ts")).default;
  const tools: { id: string; description?: string; options?: Record<string, unknown>; execute: (a: unknown, c: unknown) => Promise<unknown> }[] = [
    { id: "read", description: "Read a file.", options: {}, execute: async () => ({}) },
    { id: "grep", description: "Search file contents.", options: {}, execute: async () => ({}) },
    ...Object.entries(serena).map(([name, run]) => ({
      id: `serena_${name}`,
      description: `serena's ${name}`,
      options: { namespace: "serena", codemode: true },
      execute: async (args: unknown) => run(args as Record<string, unknown>),
    })),
  ];
  const registry = {
    list: () => tools,
    get: (id: string) => tools.find((t) => t.id === id),
    update: (id: string, change: (tool: (typeof tools)[number]) => void) => {
      const tool = tools.find((t) => t.id === id);
      if (tool) change(tool);
    },
  };
  const hooks: Record<string, Hook> = {};
  await fresh.setup({
    location: { directory: project },
    tool: {
      async hook(name, callback) {
        hooks[name] = callback as Hook;
        return { dispose: async () => {} };
      },
      async transform(change: (r: typeof registry) => void) {
        // Handed over more than once, as the real host does when its tool set changes.
        change(registry);
        change(registry);
        return { dispose: async () => {} };
      },
    },
  } as never);
  const before = async (tool: string, session: string, input: Record<string, unknown>) => {
    const event = { tool, sessionID: session, input, id: "c", agent: "build", messageID: "m" };
    await hooks["execute.before"]!(event);
    return event;
  };
  const after = async (
    tool: string,
    input: Record<string, unknown>,
    content: unknown[] = [{ type: "text", text: "Edited." }],
    status = "completed",
  ) => {
    const event = { tool, sessionID: "s-after", input, id: "c", status, result: { content } };
    await hooks["execute.after"]!(event as never);
    return event.result.content as { text: string }[];
  };
  return { tools, before, after };
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
      /serena_ide_find_symbol\(\{ query: "compose" \}\)/,
    );
  });

  it("opencode 2 is told to go through execute, never a serena_ tool it does not have", async () => {
    const refusal = await asV2("shell", "v2-grep", { command: "grep -rn compose src" }).catch((error: Error) => error.message);

    expect(refusal).toMatch(/execute → await tools\.serena\.ide_find_symbol\(\{ query: "…" \}\)/);
    // opencode 2's own instructions: `search` is synchronous, "call it without await".
    expect(refusal).toMatch(/`search\(\{ query: "serena" \}\)` finds it/);
    expect(refusal).not.toMatch(/serena_/);
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
  it("refuses — or under opencode 2 answers — once, and then lets the agent decide", async () => {
    await expect(asV1("grep", "v1-twice", { pattern: "startWorkflow" })).rejects.toThrow();
    await expect(asV1("grep", "v1-twice", { pattern: "startWorkflow" })).resolves.toBeUndefined();
    expect((await afterV2("grep", "v2-twice", { pattern: "startWorkflow" })).tool).toBe("execute");
    expect(await afterV2("grep", "v2-twice", { pattern: "startWorkflow" })).toMatchObject({ tool: "grep" });
  });
});

describe("the IDE first, in every piece of advice", () => {
  // Asked for on 2026-09-25: `find_symbol` had been called 165 times under opencode 2 against
  // `ide_find_symbol` 6 — and every refusal of this gate named `find_symbol` first.
  const firstNamed = (text: string) => /serena_(\w+)|tools\.serena\.(\w+)/.exec(text)?.slice(1).find(Boolean);

  it("every refusal names an ide_ tool before any other, and serena's as the answer without an IDE", async () => {
    const refusals = await Promise.all(
      [
        asV1("grep", "v1-ide-grep", { pattern: "startWorkflow" }),
        asV1("read", "v1-ide-large", { filePath: largeFile }),
        asV1("read", "v1-ide-first-small", { filePath: smallFile }),
        asV1("bash", "v1-ide-shell", { command: "grep -rn startWorkflow src" }),
        asV1("bash", "v1-ide-cat", { command: `cat ${largeFile}` }),
        asV2("shell", "v2-ide-shell", { command: "grep -rn startWorkflow src" }),
      ].map((call) => call.then(() => "", (error: Error) => error.message)),
    );

    for (const refusal of refusals) {
      expect(refusal).toMatch(/was not run/);
      expect(firstNamed(refusal)).toMatch(/^ide_/);
      expect(refusal).toMatch(/No IDE with this project open: (serena_|tools\.serena\.)(find_symbol|get_symbols_overview)/);
    }
  });

  it("the budget refusal too", async () => {
    // Four short files read whole in a session that never used serena: the fourth is over budget.
    await asV1("read", "v1-ide-budget", { filePath: smallFile }).catch(() => undefined);
    const files = [1, 2, 3, 4].map((n) => {
      const file = join(project, `budget-${n}.ts`);
      writeFileSync(file, "export const b = 1\n");
      return file;
    });
    let refusal = "";
    for (const file of files) {
      refusal = await asV1("read", "v1-ide-budget", { filePath: file }).then(() => "", (error: Error) => error.message);
    }

    expect(refusal).toMatch(/whole files opened/);
    expect(firstNamed(refusal)).toBe("ide_find_symbol");
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
      expect(await answerOf(call)).toContain('relative_path: "src-large.ts"');
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

  it("does not count towards the give-up: a session that complied keeps getting the other nudges", async () => {
    // Seen in the real opencode 1 on 2026-09-25: four strict refusals, each followed by a range —
    // and then a bare-identifier grep ran unasked, because they had counted as ignored.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await asV1("read", "v1-complied", { filePath: largeFile }).catch(() => undefined);
      await asV1("bash", "v1-complied", { command: `cat ${largeFile}` }).catch(() => undefined);
    }
    await expect(asV1("grep", "v1-complied", { pattern: "startWorkflow" })).rejects.toThrow(/was not run/);
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
    expect((await afterV2("grep", "v2-grep-inside", { pattern: "startWorkflow", path: project })).tool).toBe("execute");
  });
});

describe("opencode 2's registry: the IDE's tools as tools of their own", () => {
  // Measured in the real host on 2026-09-25: a serena tool out of code mode is offered to the model
  // from the next turn, and is gone from `execute`.
  const everyTool = ["ide_status", "ide_find_symbol", "ide_read_symbol", "ide_symbols_overview", "ide_hierarchy",
    "ide_read_document", "ide_diagnostics", "ide_refactor", "ide_apply_fix", "ide_todos", "find_symbol",
    "get_symbols_overview", "find_referencing_symbols", "search_for_pattern", "read_memory"];
  const serenaWithEveryTool = () => Object.fromEntries(everyTool.map((name) => [name, async () => reply("{}")]));

  it("promotes exactly the seven IDE tools, and leaves the rest inside execute", async () => {
    const { tools } = await withRegistry(serenaWithEveryTool());
    const direct = tools.filter((t) => t.options?.namespace === "serena" && t.options.codemode === false).map((t) => t.id);

    expect(direct.sort()).toEqual(
      ["ide_diagnostics", "ide_find_symbol", "ide_hierarchy", "ide_read_document", "ide_read_symbol", "ide_status", "ide_symbols_overview"].map((n) => `serena_${n}`),
    );
    expect(tools.find((t) => t.id === "serena_find_symbol")?.options?.codemode).toBe(true);
  });

  it("points read and grep at them, once however often the registry is handed over", async () => {
    const { tools } = await withRegistry(serenaWithEveryTool());
    const read = tools.find((t) => t.id === "read")!;

    expect(read.description).toMatch(/serena_ide_symbols_overview/);
    expect(tools.find((t) => t.id === "grep")!.description).toMatch(/serena_ide_find_symbol/);
    expect(read.description!.split("JUNON:").length).toBe(2);
  });

  it("names the promoted tools directly in its advice, and the others inside execute", async () => {
    const { before } = await withRegistry(serenaWithEveryTool());
    const refusal = await before("shell", "reg-advice", { command: "grep -rn startWorkflow src" }).then(
      () => "",
      (error: Error) => error.message,
    );

    expect(refusal).toMatch(/  serena_ide_find_symbol\(\{ query: "…" \}\)/);
    expect(refusal).not.toMatch(/tools\.serena\.ide_find_symbol/);
    expect(refusal).toMatch(/No IDE with this project open: tools\.serena\.find_symbol/);
    expect(refusal).toMatch(/serena_ide_\* tools are tools of their own/);
  });

  it("refuses an execute calling a promoted tool, naming the tool to call instead", async () => {
    const { before } = await withRegistry(serenaWithEveryTool());
    const refusal = await before("execute", "reg-execute", {
      code: 'return await tools.serena.ide_read_symbol({ name: "x" })',
    }).then(() => "", (error: Error) => error.message);

    expect(refusal).toMatch(/tools\.serena\.ide_read_symbol is not inside execute any more — serena_ide_read_symbol is a tool of its own/);
    // What stays inside execute is left alone.
    await expect(before("execute", "reg-execute", { code: 'return await tools.serena.find_symbol({ name_path_pattern: "x" })' })).resolves.toMatchObject({ tool: "execute" });
  });
});

describe("the outline opencode 2 answers a whole read with", () => {
  const declared = (name: string, kind: string, first: number, last: number, children: unknown[] = []) => ({
    locator: { name, kind },
    range: { start: { line: first - 1 }, end: { line: last - 1 } },
    children,
  });

  it("lists the IDE's declarations with their lines, one level deep", async () => {
    const { before } = await withRegistry({
      ide_symbols_overview: async () => reply({ symbols: [declared("Ledger", "class", 1, 305, [declared("entry0", "method", 3, 6)])] }),
    });
    const answer = await answerOf(await before("read", "out-ide", { path: largeFile }));

    expect(answer).toContain("answered with its outline by JUNON");
    expect(answer).toContain("1-305  class Ledger");
    expect(answer).toContain("  3-6  method entry0");
    expect(answer).toContain('serena_ide_read_symbol({ name: "…", relative_path: "src-large.ts" })');
  });

  it("names the ranges outside every declaration when they are most of the file", async () => {
    const { before } = await withRegistry({ ide_symbols_overview: async () => reply({ symbols: [declared("mockProducer", "function", 29, 34)] }) });
    const answer = await answerOf(await before("read", "out-gaps", { path: largeFile }));

    expect(answer).toContain("These declarations cover 6 of 400 lines. Outside every one of them: 1-28, 35-400");
  });

  it("says nothing of the kind when they cover the file", async () => {
    const { before } = await withRegistry({ ide_symbols_overview: async () => reply({ symbols: [declared("Ledger", "class", 1, 390)] }) });

    expect(await answerOf(await before("read", "out-covered", { path: largeFile }))).not.toContain("These declarations cover");
  });

  it("falls back to serena's language server when the IDE explains instead of answering", async () => {
    const { before } = await withRegistry({
      ide_symbols_overview: async () => reply("No IDE has this project open."),
      get_symbols_overview: async () => reply({ Class: ["Ledger"] }),
    });
    const answer = await answerOf(await before("read", "out-lsp", { path: largeFile }));

    expect(answer).toContain("From serena's language server");
    expect(answer).toContain('{"Class":["Ledger"]}');
  });

  it("answers with the refusal when serena is not connected yet — no registry entry", async () => {
    const { before } = await withRegistry({});
    const answer = await answerOf(await before("read", "out-absent", { path: largeFile }));

    expect(answer).toMatch(/was not run/);
    expect(answer).toContain("serena is not connected in this session yet");
    expect(answer).not.toContain("answered with its outline");
  });

  it("says what each one answered when neither can outline it", async () => {
    const { before } = await withRegistry({
      ide_symbols_overview: async () => reply("No IDE has this project open."),
      get_symbols_overview: async () => {
        throw new Error("language server terminated");
      },
    });
    const answer = await answerOf(await before("read", "out-neither", { path: largeFile }));

    expect(answer).toMatch(/was not run/);
    expect(answer).toContain("the IDE: No IDE has this project open.");
    expect(answer).toContain("serena: Error: language server terminated");
  });
});

describe("the grep opencode 2 answers from the index", () => {
  const declaration = (name: string, kind: string, file: string, line: number) => ({
    locator: { name, kind, documentUri: `file://${project}/${file}` },
    range: { start: { line: line - 1 } },
  });

  it("answers from the IDE's index: the declaration, and the callers of a single callable", async () => {
    const { before } = await withRegistry({
      ide_find_symbol: async () => reply({ symbols: [declaration("startWorkflow", "method", "src/Upload.ts", 10)], truncated: false }),
      ide_hierarchy: async () =>
        reply({ locations: [{ location: { uri: `file://${project}/src/Caller.ts`, range: { start: { line: 4 } } }, symbol: { locator: { name: "handle" } } }], truncated: false }),
    });
    const answer = await answerOf(await before("grep", "lk-ide", { pattern: "startWorkflow" }));

    expect(answer).toContain('grep "startWorkflow" answered from the index by JUNON');
    expect(answer).toContain("method startWorkflow — src/Upload.ts:10");
    expect(answer).toContain("Its callers, from the IDE:\n  handle — src/Caller.ts:5");
    expect(answer).toContain("run the same grep again");
  });

  it("falls back to serena's language server when no IDE answers", async () => {
    const { before } = await withRegistry({
      ide_find_symbol: async () => reply("No IDE Bridge daemon is reachable."),
      find_symbol: async () =>
        reply([{ name_path: "UploadService/startWorkflow", kind: "Method", relative_path: "app/UploadService.php", body_location: { start_line: 41, end_line: 60 } }]),
    });
    const answer = await answerOf(await before("grep", "lk-lsp", { pattern: "startWorkflow" }));

    expect(answer).toContain("From serena's language server — no IDE answered:\n  Method UploadService/startWorkflow — app/UploadService.php:42");
  });

  it("takes only exact names, and a name nothing declares is a text search: the grep runs next time", async () => {
    const { before } = await withRegistry({
      ide_find_symbol: async () => reply({ symbols: [declaration("startWorkflowLater", "method", "x.ts", 1)] }),
      find_symbol: async () => reply("[]"),
    });
    const answer = await answerOf(await before("grep", "lk-none", { pattern: "startWorkflow" }));

    expect(answer).toMatch(/^grep "startWorkflow" was not run: nothing in this project is declared as startWorkflow/);
    expect(answer).toContain("the IDE's index has no symbol named startWorkflow; serena has no symbol named startWorkflow");
    expect(answer).not.toContain("startWorkflowLater");
    expect(answer).not.toContain("ide_find_symbol");
  });

  it("keeps the full refusal when an index could not answer at all", async () => {
    const { before } = await withRegistry({
      ide_find_symbol: async () => reply("No IDE Bridge daemon is reachable."),
      find_symbol: async () => {
        throw new Error("language server terminated");
      },
    });
    const answer = await answerOf(await before("grep", "lk-broken", { pattern: "startWorkflow" }));

    expect(answer).toMatch(/^grep "startWorkflow" was not run\. Ask the index instead/);
    expect(answer).toContain("(No answer from the index: the IDE: No IDE Bridge daemon is reachable.; serena: Error: language server terminated)");
  });

  it("answers with the refusal when serena is not connected yet", async () => {
    const { before } = await withRegistry({});

    expect(await answerOf(await before("grep", "lk-absent", { pattern: "startWorkflow" }))).toContain("serena is not connected in this session yet");
  });

  it("says the index answers for the whole project when the grep was scoped", async () => {
    const { before } = await withRegistry({
      ide_find_symbol: async () => reply({ symbols: [declaration("startWorkflow", "class", "x.ts", 1)] }),
    });
    const answer = await answerOf(await before("grep", "lk-scope", { pattern: "startWorkflow", path: join(project, "src") }));

    expect(answer).toContain(`the index answers for the whole project, not only ${join(project, "src")}`);
  });
});

describe("the IDE after every edit", () => {
  // Only about the content just written: the IDE's contentHash — measured equal to the file's
  // SHA-256 on disk (PhpStorm, 2026-09-25) — must match, and the analysis must be complete.
  process.env.JUNON_GATE_EDIT_WAIT_MS = "400";
  const edited = () => {
    const file = join(project, "edited.ts");
    writeFileSync(file, `export const edited = ${Date.now()}\n`);
    return { file, hash: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}` };
  };
  const snapshot = (hash: string, diagnostics: unknown[], incomplete = false) =>
    reply({
      documents: [{ document: { uri: `file://${project}/edited.ts`, revision: { contentHash: hash } }, diagnostics }],
      ...(incomplete ? { incomplete_note: "This snapshot is incomplete" } : {}),
    });
  const error = (line: number, message: string) => ({ severity: "error", message, range: { start: { line: line - 1 } } });

  it("appends the errors the IDE finds in the content just written", async () => {
    const { file, hash } = edited();
    const { after } = await withRegistry({ ide_diagnostics: async () => snapshot(hash, [error(1, "Cannot find name 'x'"), { severity: "warning", message: "unused" }]) });
    const content = await after("edit", { path: file });

    expect(content.at(-1)!.text).toContain("JUNON: the IDE finds 1 error(s) in this file after the edit:\n  line 1: Cannot find name 'x'");
    expect(content[0]!.text).toBe("Edited.");
  });

  it("says the file is clean when the IDE finished and found nothing", async () => {
    const { file, hash } = edited();
    const { after } = await withRegistry({ ide_diagnostics: async () => snapshot(hash, []) });

    expect((await after("write", { path: file })).at(-1)!.text).toContain("the IDE finds no errors in this file after the edit");
  });

  it("says nothing while the IDE has analysed the previous content — never a stale diagnostic", async () => {
    const { file } = edited();
    const { after } = await withRegistry({
      ide_diagnostics: async () => snapshot("sha256:" + "0".repeat(64), [error(1, "about the old text")]),
      get_diagnostics_for_file: async () => reply({ "edited.ts": { Error: { x: [{}] } } }),
    });
    const content = await after("edit", { path: file });

    expect(content).toHaveLength(1);
  });

  it("asks again until the analysis of this content is complete", async () => {
    const { file, hash } = edited();
    let asked = 0;
    const { after } = await withRegistry({
      ide_diagnostics: async () => (++asked < 2 ? snapshot(hash, [], true) : snapshot(hash, [error(2, "late")])),
    });

    expect((await after("edit", { path: file })).at(-1)!.text).toContain("line 2: late");
    expect(asked).toBe(2);
  });

  it("asks serena's language server when no IDE has the project", async () => {
    const { file } = edited();
    const { after } = await withRegistry({
      ide_diagnostics: async () => reply("The IDE refused: [WORKSPACE_NOT_FOUND]"),
      get_diagnostics_for_file: async () => reply({ "edited.ts": { Error: { "<file>": [{ message: "bad" }] } } }),
    });

    expect((await after("edit", { path: file })).at(-1)!.text).toContain("serena's language server reports errors in this file after the edit");
  });

  it("leaves a failed edit alone", async () => {
    const { file, hash } = edited();
    let asked = 0;
    const { after } = await withRegistry({ ide_diagnostics: async () => (asked++, snapshot(hash, [])) });

    expect(await after("edit", { path: file }, undefined, "error")).toHaveLength(1);
    expect(asked).toBe(0);
  });

  it("leaves alone what is not a source file inside the project", async () => {
    let asked = 0;
    const { after } = await withRegistry({ ide_diagnostics: async () => (asked++, reply("{}")) });
    const notes = join(project, "notes.md");
    writeFileSync(notes, "x\n");
    const elsewhere = join(mkdtempSync(join(tmpdir(), "junon-gate-edit-")), "x.ts");
    writeFileSync(elsewhere, "x\n");

    expect(await after("edit", { path: notes })).toHaveLength(1);
    expect(await after("edit", { path: elsewhere })).toHaveLength(1);
    expect(asked).toBe(0);
  });
});

describe("every call is judged, whatever its id", () => {
  // Models that number tool calls per message — Kimi's `functions.grep:0` — reuse the same id on
  // every turn. De-duplicating by call id would silently switch the gate off after the first one.
  it("two different calls sharing an id are both judged", async () => {
    await expect(asV1("grep", "v1-kimi", { pattern: "alphaSymbol" }, "functions.grep:0")).rejects.toThrow();
    await expect(asV1("grep", "v1-kimi", { pattern: "betaSymbol" }, "functions.grep:0")).rejects.toThrow();
    await expect(asV2("shell", "v2-kimi", { command: "grep -rn alphaSymbol src" }, "functions.shell:0")).rejects.toThrow();
    await expect(asV2("shell", "v2-kimi", { command: "grep -rn betaSymbol src" }, "functions.shell:0")).rejects.toThrow();
  });
});
