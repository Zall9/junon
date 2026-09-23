import { readFileSync } from "node:fs"

/**
 * Sends the file tools to JUNON/Serena once, then gets out of the way.
 *
 * Prose did not work. Measured from opencode's own database on 2026-08-20, over the two days after
 * the subagent prompts were rewritten to insist on the symbolic tools:
 *
 *   explorer      319 calls   junon   0 (0.0%)   file 272 (85.3%)
 *   fixer         318 calls   junon  34 (10.7%)  file 230 (72.3%)
 *   orchestrator  756 calls   junon  15 (2.0%)   file 187 (24.7%)
 *
 * explorer went from 10.8% over the fortnight to zero after being told twice, in two files, to
 * prefer them. A rule that is read and not followed is not a rule, so this one is not written in a
 * prompt.
 *
 * **It refuses once per distinct call, then allows it.** Not a ban: `read` and `grep` are the right
 * answer often enough — a file outside any project, a genuine text search, a log — and an agent that
 * cannot fall back is an agent that loops. The first attempt comes back with the symbolic call that
 * answers the same question better; repeating the call runs it. The cost of being wrong here is one
 * round-trip, and the cost of being right is a whole file that never enters the context.
 *
 * Every agent that this touches — explorer, fixer, orchestrator, oracle — already has serena in its
 * `mcps` list, so nothing is being asked of them that they cannot do.
 *
 * **One file, both opencodes.** opencode 1 takes the default export's `server` and calls its
 * `tool.execute.before`; opencode 2 takes its `setup` and registers a hook through `ctx.tool.hook`
 * (measured — see the export at the end). Both sit over one decision, and nothing is imported from
 * either host's plugin package — so the file loads under both, and a machine that rolls back loses
 * nothing.
 * The migration to opencode 2 had produced a second copy, ported by hand and living only on the
 * machine; the next update would have overwritten it with this file's opencode 1 form.
 */

/** Files where a symbol tree exists and reading the whole thing is the wasteful way in. */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|kt|kts|go|java|rs|rb|php|c|h|hpp|cc|cpp|swift|scala|cs|vue|svelte)$/i

/** A bare name — what someone types when they are looking for a definition, not for text. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/

/**
 * Below this, reading the file is cheaper than three symbolic calls, and the nudge would be noise.
 * Chosen from the measurement: `read` on this repository averages well past it, and files under it
 * are configs and tests where the whole point is the whole file.
 */
const WHOLE_FILE_IS_FINE = 300

/** One refusal per session and per call. The second attempt is the agent's decision, and it stands. */
const alreadyNudged = new Set<string>()

/**
 * Whole-file reads of code allowed per session before the next one is refused.
 *
 * The size rule catches the wrong unit; this one catches the wrong pattern — thirty files opened to
 * find one function. Swept over a fortnight of real calls: at five, explorer's refusal rate goes
 * from 13.6% to 22.5% while orchestrator, which already reads by range 484 times a fortnight, moves
 * 6.4% to 7.4%. A rule that starts punishing the agent doing it right is a rule that gets deleted.
 */
const WHOLE_FILE_BUDGET = 5

/**
 * The same budget for a session that has never reached for a symbolic tool. Lower on purpose: five
 * whole files is a generous allowance for someone who has shown they know the other route, and too
 * generous for someone who has not.
 */
const WHOLE_FILE_BUDGET_UNPROVEN = 3

/** Which budget applies to this session. */
function budgetFor(session: string): number {
  return usesSymbolicTools.has(session) ? WHOLE_FILE_BUDGET : WHOLE_FILE_BUDGET_UNPROVEN
}

/**
 * Sessions already told once that a short source file has a symbolic route.
 *
 * A project made of small files let a session read all of it without ever touching the index: every
 * read was under the line threshold and the budget was never spent. One nudge per session covers
 * that, and only for a session that has never used a symbolic tool — there is nothing to teach the
 * one that has.
 */
const nudgedAboutSmallFiles = new Set<string>()

/** Whole-file code reads seen this session. Per process, which is per opencode run. */
const spent = new Map<string, number>()

/**
 * Sessions that have used a symbolic tool at least once — proof the agent has them at all.
 *
 * Not every agent does: `gitlab-review-orchestrator` has no serena in its `mcps`, and three of the
 * first five refusals went to it, naming a tool it could not call. opencode 1 gives the hook only
 * `{tool, sessionID, callID}`, so which agent is asking is not knowable there — but what the session
 * has *done* is, and that answers the same question under both hosts without reading anyone's
 * configuration. Under opencode 2 "done" is an `execute` whose code calls `tools.serena`.
 */
const usesSymbolicTools = new Set<string>()

/** Refusals a session has ignored in a row. Reset the moment it makes a symbolic call. */
const unheeded = new Map<string, number>()

/**
 * After this many refusals that changed nothing, in a session that has never used a symbolic tool,
 * the gate stops. Two, because the cost of being wrong is a wasted round-trip each time and the
 * evidence after two is already clear.
 */
const GIVE_UP_AFTER = 3

/** Whether nudging this session is still worth a round-trip. */
function worthNudging(session: string): boolean {
  if (usesSymbolicTools.has(session)) return true
  return (unheeded.get(session) ?? 0) < GIVE_UP_AFTER
}

/** Commands that answer a question the symbol index answers better. */
const SEARCH_COMMANDS = new Set(["grep", "rg", "ag", "ack"])
const READ_COMMANDS = new Set(["cat", "bat"])

/**
 * The first word of each `&&`, `;` or `|` separated segment.
 *
 * Not a shell parser and not trying to be: it misses quoting, subshells and aliases. It catches
 * `cd /somewhere && grep -rn thing .`, which is the form the orchestrator actually used to walk
 * around this gate on the first day it ran.
 */
function firstWords(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
}

function lineCount(path: string): number {
  try {
    let lines = 0
    const text = readFileSync(path, "utf8")
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
    return lines
  } catch {
    // Unreadable, binary, or gone: not this plugin's business, and never a reason to block a call.
    return 0
  }
}


/** A file that is plainly not source: a log, a config, a lock file, data. */
const NOT_SOURCE = /\.(log|ya?ml|json|toml|ini|conf|cfg|lock|txt|csv|md|env)$/i

/**
 * Whether one shell segment asks a question the symbol index answers.
 *
 * Scoped to the segment holding the command, because judging the whole line let
 * `cd /tmp && grep -rn publishedCheck .` through: the token after `cd` is `&&`, which is not an
 * identifier. And it asks *where* as well as *what*, because `grep ERROR /var/log/system.log` is a
 * log question wearing an identifier's clothes.
 *
 * Conservative by design: it must positively recognise a symbol question, and lets everything else
 * pass. A missed nudge costs nothing anybody notices; a refusal with no business happening is how a
 * gate gets deleted.
 */
function segmentAsksAboutSymbols(segment: string, searching: boolean): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean)
  const rest = tokens.slice(1).filter((token) => !token.startsWith("-"))
  const bare = (token: string) => token.replace(/^["']|["']$/g, "")

  if (searching) {
    const pattern = rest.length > 0 ? bare(rest[0]!) : ""
    if (!IDENTIFIER.test(pattern)) return false
    // Where it is being searched decides what kind of question it is.
    const targets = rest.slice(1).map(bare)
    if (targets.some((target) => NOT_SOURCE.test(target))) return false
    return true
  }
  return rest.map(bare).some((token) => CODE.test(token))
}

/** The segment whose first word is one of `commands`, if any. */
function segmentFor(command: string, commands: Set<string>): string {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const first = segment.trim().split(/\s+/)[0] ?? ""
    if (commands.has(first)) return segment.trim()
  }
  return ""
}

/** Which opencode is asking. They expose MCP tools differently, and advice must match the asker. */
type Host = 1 | 2

/**
 * A serena call written the way this host lets a model make it.
 *
 * opencode 1 exposes every MCP tool as a tool of its own: `serena_find_symbol`. opencode 2 exposes
 * none of them. A model reaches them through the `execute` meta-tool, as code — measured in the
 * user's own sessions on 2026-09-23: `await tools.serena.find_symbol({...})`, after `search` has
 * loaded them. Until this was written the gate named `serena_find_symbol` to opencode 2 models too:
 * a tool they could not call.
 */
function serena(host: Host, name: string, args: string): string {
  return host === 1 ? `serena_${name}(${args})` : `execute → await tools.serena.${name}(${args})`
}

/** The line only an opencode 2 model needs: where those calls go, and how to load them. */
function howToCall(host: Host): string {
  return host === 1
    ? ""
    : `In opencode 2 these run inside the \`execute\` tool; if \`tools.serena\` is not there yet, ` +
        `\`await search({ query: "serena" })\` loads it.\n`
}

/** `tools.serena.x` or `tools["serena"].x` — a symbolic call, as opencode 2 makes it. */
const SERENA_IN_CODE = /\btools\s*(?:\.\s*serena\b|\[\s*["']serena["']\s*\])/

/** Whether this call is the session using the symbolic tools, under either host. */
function isSymbolicCall(tool: string, args: Record<string, unknown>): boolean {
  if (tool.startsWith("serena")) return true
  return tool === "execute" && SERENA_IN_CODE.test(String(args.code ?? ""))
}

/**
 * A path as serena wants it: relative to the project when it lies inside it. The file tools pass
 * absolute paths, and `relative_path` is what every serena tool is declared with.
 */
function projectRelative(path: string, directory: string | undefined): string {
  if (!directory) return path
  const root = directory.endsWith("/") ? directory : `${directory}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/**
 * The decision, for either host: the sentence to refuse this call with, or nothing.
 *
 * Returned rather than thrown so both entry points share it unchanged; each throws it the way its
 * host expects a hook to refuse.
 */
function gate(
  host: Host,
  rawTool: unknown,
  args: Record<string, unknown>,
  rawSession: unknown,
  directory?: string,
): string | undefined {
  const tool = String(rawTool ?? "").toLowerCase()
  const session = String(rawSession ?? "no-session")

  // Every call passes through here, which is what makes the session's own behaviour readable
  // without asking anyone: a session that reaches for a symbolic tool has them.
  if (isSymbolicCall(tool, args)) {
    usesSymbolicTools.add(session)
    unheeded.set(session, 0)
    return undefined
  }

  // `bash` in opencode 1, `shell` in opencode 2 — measured from each host's own tool list.
  if (tool === "bash" || tool === "shell") {
    if (!worthNudging(session)) return undefined
    const command = String(args.command ?? "")
    const words = firstWords(command)
    const searching = words.find((word) => SEARCH_COMMANDS.has(word))
    const reading = words.find((word) => READ_COMMANDS.has(word))
    if (!searching && !reading) return undefined
    // What it is aimed at, not just what it is. Judging the verb alone refused
    // `cat .serena/project.yml` during a diagnosis — a config file, which this rule's own message
    // promises to let through. The tool-level rules were always careful here; this one was not.
    const segment = segmentFor(command, searching ? SEARCH_COMMANDS : READ_COMMANDS)
    if (!segment || !segmentAsksAboutSymbols(segment, Boolean(searching))) return undefined

    const key = `${session}:shell:${command.slice(0, 120)}`
    if (alreadyNudged.has(key)) return undefined
    alreadyNudged.add(key)
    unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

    return (
      `That command was not run: it uses \`${searching ?? reading}\` to answer a question the ` +
      `symbol index answers better, and running it through the shell reaches the same dead end as ` +
      `the tool would.\n` +
      `  ${serena(host, "find_symbol", '{ name_path_pattern: "…" }')}  — where something is defined\n` +
      `  ${serena(host, "find_referencing_symbols", '{ name_path: "…", relative_path: "…" }')}  — who uses it\n` +
      `  ${serena(host, "ide_read_symbol", '{ name: "…" }')}  — one declaration, from the running IDE\n` +
      howToCall(host) +
      `If the command is really about text or files — a log, a config, a build output — run it ` +
      `again and it will go through.`
    )
  }

  if (tool !== "read" && tool !== "grep") return undefined
  if (!worthNudging(session)) return undefined

  if (tool === "grep") {
    const pattern = String(args.pattern ?? "")
    // A regex is a text search and this has no opinion about it. A bare identifier is a question
    // about a symbol, and grep answers it with every comment, string and unrelated name that
    // happens to contain it.
    if (!IDENTIFIER.test(pattern)) return undefined

    const key = `${session}:grep:${pattern}`
    if (alreadyNudged.has(key)) return undefined
    alreadyNudged.add(key)
    unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

    return (
      `grep "${pattern}" was not run. Ask the index instead — it resolves what a text search ` +
      `cannot:\n` +
      `  ${serena(host, "find_symbol", `{ name_path_pattern: "${pattern}" }`)}  — the definition\n` +
      `  ${serena(host, "find_referencing_symbols", '{ name_path: "…", relative_path: "…" }')}  — real callers, including overrides\n` +
      `  ${serena(host, "ide_find_symbol", `{ query: "${pattern}" }`)}  — the same, from the running IDE\n` +
      howToCall(host) +
      `If you genuinely want text — a log line, a config value, a string — run the same grep ` +
      `again and it will go through, or pass a regex.`
    )
  }

  // `filePath` in opencode 1, `path` in opencode 2 — measured from each host's tool schema.
  const path = String(args.filePath ?? args.path ?? "")
  if (!path || !CODE.test(path)) return undefined
  // A range means the caller already knows what they want. Nothing to teach.
  if (args.offset !== undefined || args.limit !== undefined) return undefined
  const relative = projectRelative(path, directory)

  const lines = lineCount(path)
  const used = (spent.get(session) ?? 0) + 1
  spent.set(session, used)
  const overBudget = used > budgetFor(session)

  if (lines < WHOLE_FILE_IS_FINE && !overBudget) {
    // A project of small files was a way to read everything without ever being asked: each read
    // is under the threshold and the budget is never spent. One nudge per session closes it, and
    // only where there is something to teach.
    if (usesSymbolicTools.has(session) || nudgedAboutSmallFiles.has(session)) return undefined
    nudgedAboutSmallFiles.add(session)
    unheeded.set(session, (unheeded.get(session) ?? 0) + 1)
    return (
      `read of ${path} was not run — this session has not asked the index anything yet, and a ` +
      `short file is still a file read whole:\n` +
      `  ${serena(host, "ide_read_symbol", `{ name: "…", relative_path: "${relative}" }`)}  — one declaration, from the running IDE\n` +
      `  ${serena(host, "find_symbol", `{ name_path_pattern: "…", relative_path: "${relative}", include_body: true }`)}\n` +
      howToCall(host) +
      `Said once per session. Run the same read again and it will go through, as will every ` +
      `short file after it.`
    )
  }

  const key = `${session}:read:${path}`
  if (alreadyNudged.has(key)) return undefined
  alreadyNudged.add(key)
  unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

  if (overBudget && lines < WHOLE_FILE_IS_FINE) {
    return (
      `read of ${path} was not run — that is ${used} whole files opened in this session. Reading ` +
      `them one after another to find something is the search the symbol index does in one call:\n` +
      `  ${serena(host, "find_symbol", '{ name_path_pattern: "…" }')}  — where it is defined\n` +
      `  ${serena(host, "find_referencing_symbols", '{ name_path: "…", relative_path: "…" }')}  — who uses it\n` +
      `  ${serena(host, "search_for_pattern", '{ substring_pattern: "…" }')}  — text, but scoped\n` +
      howToCall(host) +
      `Run the same read again and it will go through.`
    )
  }

  return (
    `read of ${path} (${lines} lines) was not run — the whole file would enter the context to ` +
    `answer a question about part of it:\n` +
    `  ${serena(host, "get_symbols_overview", `{ relative_path: "${relative}" }`)}  — what is in it\n` +
    `  ${serena(host, "find_symbol", `{ name_path_pattern: "…", relative_path: "${relative}", include_body: true }`)}  — one declaration\n` +
    `  ${serena(host, "ide_read_document", `{ relative_path: "${relative}" }`)}  — the file as the ` +
    `editor holds it, unsaved edits included — which the disk does not have\n` +
    howToCall(host) +
    `If you do need the raw file, pass offset/limit, or run the same read again and it will go through.`
  )
}

// --- the entry points ---------------------------------------------------------------------------

interface V1Context {
  readonly directory?: string
}

/** opencode 1's plugin: called once per project instance, its hook once per tool call. */
const opencode1 = async (ctx?: V1Context) => ({
  "tool.execute.before": async (input: any, output: any) => {
    const refusal = gate(1, input?.tool, (output?.args ?? {}) as Record<string, unknown>, input?.sessionID, ctx?.directory)
    if (refusal !== undefined) throw new Error(refusal)
  },
})

/** The part of opencode 2's plugin context this uses — declared here so nothing has to be imported. */
interface V2Context {
  readonly location?: { readonly directory?: string }
  readonly tool: {
    hook(
      name: "execute.before",
      callback: (event: { tool: string; readonly sessionID: string; input: unknown }) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>
  }
}

/**
 * One default export, read by both hosts — measured with a traced copy under each, 2026-09-23:
 *
 * - opencode 1.18 takes `server` whenever the default export exists, and then ignores named exports.
 *   The first version of this file had a named plugin and a default with only `setup`; opencode 1
 *   loaded it and never ran the gate.
 * - opencode 2.0 takes `setup`.
 * - Each runs the hook exactly once per tool call. No host registered it twice, so nothing here
 *   de-duplicates calls — which would have been dangerous besides: models that number their tool
 *   calls per message (Kimi's `functions.grep:0`) reuse the same id on every turn.
 *
 * It is also the shape oh-my-opencode-slim ships, which both hosts already load on this machine.
 */
export default {
  id: "junon-first",
  server: opencode1,
  async setup(ctx: V2Context) {
    const directory = ctx.location?.directory
    const registration = await ctx.tool.hook("execute.before", async (event) => {
      const refusal = gate(2, event.tool, (event.input ?? {}) as Record<string, unknown>, event.sessionID, directory)
      if (refusal !== undefined) throw new Error(refusal)
    })
    return () => registration.dispose()
  },
}
