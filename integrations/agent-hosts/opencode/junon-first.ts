import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative as relativeTo, resolve } from "node:path"

/**
 * Sends the file tools to JUNON/Serena — once for a guess, always for a whole large file.
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
 * **A guess is refused once, then allowed.** A bare-identifier `grep`, a short file, one file too many:
 * `read` and `grep` are the right answer often enough — a genuine text search, a log — and an agent
 * that cannot fall back is an agent that loops. Repeating the call runs it.
 *
 * **A whole read of a large source file is never allowed** — measured, 2026-09-24: repeating the call
 * was the cheapest way around the gate, and after a refusal agents went to `sed`, `cat` and the next
 * file more than twice as often as to serena. The way out is a range, which every agent has, so nothing
 * becomes unreachable. opencode 2 goes further and answers that read with the file's outline, from
 * JUNON, instead of refusing it (see `outlineProgram`).
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

/**
 * Commands that print a whole file. `sed -n`, `head` and `tail` print a range and are not here: a
 * range is what the gate asks for.
 */
const READ_COMMANDS = new Set(["cat", "bat", "less", "more", "nl"])

/**
 * The first word of each `&&`, `;` or `|` separated segment.
 *
 * Not a shell parser and not trying to be: it misses quoting, subshells and aliases. It catches
 * `cd /somewhere && grep -rn thing .`, which is the form the orchestrator actually used to walk
 * around this gate on the first day it ran.
 */
function firstWords(command: string): string[] {
  command = masked(command)
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
}

/**
 * The command with `|`, `;` and `&` inside quotes masked, so `grep -E "tool|error" x.log` stays one
 * search for a regex — split naively, it read as `grep "tool`, a bare identifier, and was refused.
 */
function masked(command: string): string {
  let quote = ""
  let out = ""
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ""
      out += "|;&".includes(char) ? "\u0001" : char
    } else {
      if (char === "'" || char === '"') quote = char
      out += char
    }
  }
  return out
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
function segmentAsksAboutSymbols(segment: string, searching: boolean, directory: string | undefined): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean)
  const rest = tokens.slice(1).filter((token) => !token.startsWith("-"))
  const bare = (token: string) => token.replace(/^["']|["']$/g, "")
  const inside = (token: string) => withinProject(absolute(token, directory), directory) !== undefined

  if (searching) {
    const pattern = rest.length > 0 ? bare(rest[0]!) : ""
    if (!IDENTIFIER.test(pattern)) return false
    // Where it is being searched decides what kind of question it is.
    const targets = rest.slice(1).map(bare)
    if (targets.some((target) => NOT_SOURCE.test(target) || !inside(target))) return false
    return true
  }
  return rest.map(bare).some((token) => CODE.test(token) && inside(token))
}

/**
 * The first stage of a statement whose first word is one of `commands`, if any.
 *
 * Only a first stage: a `grep` fed by a pipe filters output, not files. And a whole-file reader only
 * when nothing follows it — `cat Big.php | wc -l` prints nothing whole.
 */
function segmentFor(command: string, commands: Set<string>, unpiped: boolean): string {
  for (const statement of command.split(/&&|\|\||;/)) {
    const stages = statement.split("|")
    const first = stages[0]!.trim()
    if (!commands.has(first.split(/\s+/)[0] ?? "")) continue
    if (unpiped && stages.length > 1) continue
    return first
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

/**
 * serena's language-server tools, named as what they are: the answer for a project no IDE has open.
 *
 * The IDE's tools come first everywhere — asked for on 2026-09-25, after counting what agents called
 * under opencode 2: `find_symbol` 165 times against `ide_find_symbol` 6 and `ide_read_symbol` 16. The
 * gate had been teaching that, naming `find_symbol` first in every refusal.
 */
function withoutAnIde(host: Host, ...names: string[]): string {
  const called = names.map((name) => (host === 1 ? `serena_${name}` : `tools.serena.${name}`)).join(", ")
  return `  No IDE with this project open: ${called} answer the same from serena's language server.\n`
}

/** The line only an opencode 2 model needs: where those calls go, and how to load them. */
function howToCall(host: Host): string {
  return host === 1
    ? ""
    : `In opencode 2 these run inside the \`execute\` tool; if \`tools.serena\` is not there yet, ` +
        `\`search({ query: "serena" })\` finds it.\n`
}

/** `tools.serena.x` or `tools["serena"].x` — a symbolic call, as opencode 2 makes it. */
const SERENA_IN_CODE = /\btools\s*(?:\.\s*serena\b|\[\s*["']serena["']\s*\])/

/** Whether this call is the session using the symbolic tools, under either host. */
function isSymbolicCall(tool: string, args: Record<string, unknown>): boolean {
  if (tool.startsWith("serena")) return true
  return tool === "execute" && SERENA_IN_CODE.test(String(args.code ?? ""))
}

/** The real path when it exists: `/tmp` and `/private/tmp` are one directory on macOS. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Where a file argument points, resolved against the session's directory when it is relative. */
function absolute(path: string, directory: string | undefined): string {
  return isAbsolute(path) || !directory ? path : resolve(directory, path)
}

/**
 * A path as serena wants it — relative to the project — or `undefined` when the file lies outside
 * the project, where JUNON has nothing to say and so neither has the gate. The file tools pass
 * absolute paths, and `relative_path` is what every serena tool is declared with. An unknown project
 * counts as containing everything, which is how the gate behaved before it asked.
 */
function withinProject(file: string, directory: string | undefined): string | undefined {
  if (!directory) return file
  // As written, then resolved: a path that does not exist has no real form, and comparing it with
  // the project's real one would put every such path outside.
  for (const [root, target] of [[directory, file], [real(directory), real(file)]] as const) {
    const inside = relativeTo(root, target)
    if (inside === "") return "."
    if (!inside.startsWith("..") && !isAbsolute(inside)) return inside
  }
  return undefined
}

/**
 * The first large source file a command prints whole, if any: `cat Big.php`, `nl src/x.ts`.
 *
 * A pipeline is left alone — `cat Big.php | grep x` is a search and `| head` a range — and so is a
 * path this cannot resolve, such as one relative to a `cd` earlier in the line.
 */
function largeWholeFileRead(command: string, directory: string | undefined): { file: string; lines: number } | undefined {
  for (const statement of command.split(/&&|\|\||;/)) {
    if (statement.includes("|")) continue
    const tokens = statement.trim().split(/\s+/)
    if (!READ_COMMANDS.has(tokens[0] ?? "")) continue
    for (const token of tokens.slice(1)) {
      const bare = token.replace(/^["']|["']$/g, "")
      if (bare.startsWith("-") || !CODE.test(bare)) continue
      const file = absolute(bare, directory)
      if (withinProject(file, directory) === undefined) continue
      const lines = lineCount(file)
      if (lines >= WHOLE_FILE_IS_FINE) return { file: bare, lines }
    }
  }
  return undefined
}

/**
 * What the gate decided about one call. Every host can refuse; opencode 2 can also answer a whole
 * read of a large file with its outline, and does, keeping the refusal for when no outline comes.
 */
interface Decision {
  readonly refusal: string
  readonly outline?: { readonly path: string; readonly relative: string; readonly lines: number }
  /** A bare-identifier grep, which opencode 2 answers from the IDE's index instead. */
  readonly lookup?: { readonly pattern: string; readonly scope?: string }
}

/**
 * The decision, for either host: what to do instead of this call, or nothing.
 *
 * Returned rather than thrown so both entry points share it unchanged; each acts on it the way its
 * host lets a hook act.
 */
function gate(
  host: Host,
  rawTool: unknown,
  args: Record<string, unknown>,
  rawSession: unknown,
  directory?: string,
): Decision | undefined {
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
    const command = masked(String(args.command ?? ""))
    // Ahead of the give-up: this is not a guess about intent, and a range is always there instead.
    // Nor does it count towards the give-up: a session refused here then reads a range, which is
    // compliance — counted, it switched the guesses off in sessions that had followed this rule.
    const large = largeWholeFileRead(command, directory)
    if (large) {
      return {
        refusal:
          `That command was not run, and will not be on another try: it prints ${large.file} ` +
          `(${large.lines} lines) whole, and a source file this size is not read whole by any route.\n` +
          `  ${serena(host, "ide_symbols_overview", `{ relative_path: "…" }`)}  — its declarations, with their lines\n` +
          `  ${serena(host, "ide_read_symbol", `{ name: "…", relative_path: "…" }`)}  — one declaration\n` +
          withoutAnIde(host, "get_symbols_overview", "find_symbol") +
          howToCall(host) +
          `For the text itself, print a range — \`sed -n '120,180p' ${large.file}\`, or \`read\` with ` +
          `offset and limit. A range is never refused.`,
      }
    }
    if (!worthNudging(session)) return undefined
    const words = firstWords(command)
    const searching = words.find((word) => SEARCH_COMMANDS.has(word))
    const reading = words.find((word) => READ_COMMANDS.has(word))
    if (!searching && !reading) return undefined
    // What it is aimed at, not just what it is. Judging the verb alone refused
    // `cat .serena/project.yml` during a diagnosis — a config file, which this rule's own message
    // promises to let through. The tool-level rules were always careful here; this one was not.
    const segment = searching
      ? segmentFor(command, SEARCH_COMMANDS, false)
      : segmentFor(command, READ_COMMANDS, true)
    if (!segment || !segmentAsksAboutSymbols(segment, Boolean(searching), directory)) return undefined

    const key = `${session}:shell:${command.slice(0, 120)}`
    if (alreadyNudged.has(key)) return undefined
    alreadyNudged.add(key)
    unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

    return {
      refusal:
        `That command was not run: it uses \`${searching ?? reading}\` to answer a question the ` +
        `symbol index answers better, and running it through the shell reaches the same dead end as ` +
        `the tool would.\n` +
        `  ${serena(host, "ide_find_symbol", '{ query: "…" }')}  — where something is defined, from the IDE's index\n` +
        `  ${serena(host, "ide_hierarchy", '{ name: "…", relation: "callers" }')}  — who calls it\n` +
        `  ${serena(host, "ide_read_symbol", '{ name: "…" }')}  — one declaration\n` +
        withoutAnIde(host, "find_symbol", "find_referencing_symbols") +
        howToCall(host) +
        `If the command is really about text or files — a log, a config, a build output — run it ` +
        `again and it will go through.`,
    }
  }

  if (tool !== "read" && tool !== "grep") return undefined

  if (tool === "grep") {
    if (!worthNudging(session)) return undefined
    const pattern = String(args.pattern ?? "")
    // A regex is a text search and this has no opinion about it. A bare identifier is a question
    // about a symbol, and grep answers it with every comment, string and unrelated name that
    // happens to contain it.
    if (!IDENTIFIER.test(pattern)) return undefined
    const where = args.path === undefined ? undefined : String(args.path)
    if (where && withinProject(absolute(where, directory), directory) === undefined) return undefined

    const key = `${session}:grep:${pattern}`
    if (alreadyNudged.has(key)) return undefined
    alreadyNudged.add(key)
    // Under opencode 2 this is answered, not refused, so it is not a refusal left unheeded.
    if (host === 1) unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

    return {
      lookup: { pattern, scope: where ?? (args.include === undefined ? undefined : String(args.include)) },
      refusal:
        `grep "${pattern}" was not run. Ask the index instead — it resolves what a text search ` +
        `cannot:\n` +
        `  ${serena(host, "ide_find_symbol", `{ query: "${pattern}" }`)}  — the definition, from the IDE's index\n` +
        `  ${serena(host, "ide_hierarchy", `{ name: "${pattern}", relation: "callers" }`)}  — its real callers\n` +
        withoutAnIde(host, "find_symbol", "find_referencing_symbols") +
        howToCall(host) +
        `If you genuinely want text — a log line, a config value, a string — run the same grep ` +
        `again and it will go through, or pass a regex.`,
    }
  }

  // `filePath` in opencode 1, `path` in opencode 2 — measured from each host's tool schema.
  const path = String(args.filePath ?? args.path ?? "")
  if (!path || !CODE.test(path)) return undefined
  // A range means the caller already knows what they want. Nothing to teach.
  if (args.offset !== undefined || args.limit !== undefined) return undefined
  const file = absolute(path, directory)
  const relative = withinProject(file, directory)
  if (relative === undefined) return undefined
  const lines = lineCount(file)

  // Not a guess, so ahead of the give-up, never let through on a second try, and never counted
  // towards the give-up: the way out is a range, which every agent has, and taking it is compliance.
  // opencode 2 answers it with the outline instead of this refusal.
  if (lines >= WHOLE_FILE_IS_FINE) {
    return {
      refusal:
        `read of ${path} (${lines} lines) was not run, and will not be on another try — the whole ` +
        `file would enter the context to answer a question about part of it:\n` +
        `  ${serena(host, "ide_symbols_overview", `{ relative_path: "${relative}" }`)}  — its declarations, with their lines\n` +
        `  ${serena(host, "ide_read_symbol", `{ name: "…", relative_path: "${relative}" }`)}  — one declaration\n` +
        withoutAnIde(host, "get_symbols_overview", "find_symbol") +
        howToCall(host) +
        `For the text itself, pass offset and limit — a range is never refused.`,
      outline: { path, relative, lines },
    }
  }

  if (!worthNudging(session)) return undefined
  const used = (spent.get(session) ?? 0) + 1
  spent.set(session, used)
  const overBudget = used > budgetFor(session)

  if (!overBudget) {
    // A project of small files was a way to read everything without ever being asked: each read
    // is under the threshold and the budget is never spent. One nudge per session closes it, and
    // only where there is something to teach.
    if (usesSymbolicTools.has(session) || nudgedAboutSmallFiles.has(session)) return undefined
    nudgedAboutSmallFiles.add(session)
    unheeded.set(session, (unheeded.get(session) ?? 0) + 1)
    return {
      refusal:
        `read of ${path} was not run — this session has not asked the index anything yet, and a ` +
        `short file is still a file read whole:\n` +
        `  ${serena(host, "ide_read_symbol", `{ name: "…", relative_path: "${relative}" }`)}  — one declaration\n` +
        `  ${serena(host, "ide_symbols_overview", `{ relative_path: "${relative}" }`)}  — what is in it\n` +
        withoutAnIde(host, "find_symbol", "get_symbols_overview") +
        howToCall(host) +
        `Said once per session. Run the same read again and it will go through, as will every ` +
        `short file after it.`,
    }
  }

  const key = `${session}:read:${path}`
  if (alreadyNudged.has(key)) return undefined
  alreadyNudged.add(key)
  unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

  return {
    refusal:
      `read of ${path} was not run — that is ${used} whole files opened in this session. Reading ` +
      `them one after another to find something is the search the symbol index does in one call:\n` +
      `  ${serena(host, "ide_find_symbol", '{ query: "…" }')}  — where it is defined, from the IDE's index\n` +
      `  ${serena(host, "ide_hierarchy", '{ name: "…", relation: "callers" }')}  — who calls it\n` +
      `  ${serena(host, "search_for_pattern", '{ substring_pattern: "…" }')}  — text, but scoped\n` +
      withoutAnIde(host, "find_symbol", "find_referencing_symbols") +
      howToCall(host) +
      `Run the same read again and it will go through.`,
  }
}

/** What an outline answer starts with — and what `junon-usage.py` counts outlines by. */
const OUTLINED = "answered with its outline by JUNON"

/**
 * The `execute` program opencode 2 runs in place of a whole read of a large file.
 *
 * Measured in the real opencode 2 before it was written (2026-09-24): a hook that sets `event.tool`
 * and `event.input` runs the new call, and its output comes back to the model as the answer to the
 * `read` it made — the database still records a `read`, with the program's output. `edit` needs no
 * prior `read` there, so answering the read with an outline cannot block an edit.
 *
 * Inside `execute`, the catalog is fixed for the turn: in a session's first turn serena can be missing
 * from it while `ctx.mcp.list()` already reports it connected, and there is no timer to wait with.
 * A server missing from it still has `tools.serena`, which throws "Unknown tool" when called.
 *
 * The IDE's outline first, because it carries lines: the next read can then be the range. Serena's
 * language server second. And when neither answers, the refusal the other hosts get — as the read's
 * result rather than an error, so the model reads why and what to do.
 */
function outlineProgram(outline: NonNullable<Decision["outline"]>, refusal: string): string {
  const header =
    `read of ${outline.path} (${outline.lines} lines) ${OUTLINED}, not with its text — a whole ` +
    `read of a source file this size always is.\n` +
    `For the text you need, read that range: offset and limit, with the lines listed below. A range ` +
    `is never touched.\n` +
    `One declaration: await tools.serena.ide_read_symbol({ name: "…", relative_path: ` +
    `"${outline.relative}" }), inside execute.\n`
  return `/* junon-first: outline */
const relative = ${JSON.stringify(outline.relative)}
const header = ${JSON.stringify(header)}
const refusal = ${JSON.stringify(refusal)}
const text = (answer) => {
  const value = answer && typeof answer === "object" && "result" in answer ? answer.result : answer
  return typeof value === "string" ? value : JSON.stringify(value)
}
const absent = refusal + "\\n(No outline: serena is not in this turn's tool catalog — once it is connected, the next call has it.)"
// Seen on 2026-09-25: a 315-line Pest test file outlined as one function — its it() blocks are not
// declarations. An outline that leaves most of the file out says which lines, so they can be read.
const uncovered = (symbols) => {
  const total = ${outline.lines}
  const spans = (Array.isArray(symbols) ? symbols : [])
    .map((s) => [((s && s.range && s.range.start && s.range.start.line) || 0) + 1, ((s && s.range && s.range.end && s.range.end.line) || 0) + 1])
    .sort((a, b) => a[0] - b[0])
  const gaps = []
  let next = 1
  let covered = 0
  for (const [first, last] of spans) {
    if (first > next) gaps.push([next, first - 1])
    covered += Math.max(0, last - Math.max(first, next) + 1)
    next = Math.max(next, last + 1)
  }
  if (next <= total) gaps.push([next, total])
  if (covered * 2 >= total) return ""
  const listed = gaps.filter(([a, b]) => b - a >= 2).slice(0, 12).map(([a, b]) => a + "-" + b)
  return "\\n\\nThese declarations cover " + covered + " of " + total + " lines. Outside every one of them: " +
    listed.join(", ") + " — a test file's it() and test() blocks, a script's statements and a config's " +
    "arrays are not declarations. Read those ranges."
}
if (typeof tools !== "object" || tools === null || tools.serena === undefined) return absent
const why = []
try {
  const answer = text(await tools.serena.ide_symbols_overview({ relative_path: relative }))
  let parsed
  try { parsed = JSON.parse(answer) } catch { why.push("the IDE: " + answer.slice(0, 240)) }
  const rows = []
  const walk = (symbols, depth) => {
    for (const symbol of Array.isArray(symbols) ? symbols : []) {
      if (rows.length >= 400) return
      const locator = (symbol && symbol.locator) || {}
      const range = (symbol && symbol.range) || {}
      const first = ((range.start && range.start.line) || 0) + 1
      const last = ((range.end && range.end.line) || 0) + 1
      rows.push("  ".repeat(depth) + first + "-" + last + "  " + (locator.kind || "symbol") + " " + (locator.name || "?"))
      if (depth < 1) walk(symbol && symbol.children, depth + 1)
    }
  }
  if (parsed) {
    walk(parsed.symbols, 0)
    if (rows.length) return header + "\\nFrom the IDE — first-last line, kind, name:\\n" + rows.join("\\n") + uncovered(parsed.symbols)
    why.push("the IDE listed no declarations")
  }
} catch (error) {
  // A server missing from the turn's catalog shows only when called: \`tools.serena\` is still there.
  if (/Unknown tool/.test(String(error))) return absent
  why.push("the IDE: " + String(error).slice(0, 240))
}
try {
  const overview = text(await tools.serena.get_symbols_overview({ relative_path: relative, depth: 1 }))
  let parsed
  try { parsed = JSON.parse(overview) } catch { why.push("serena: " + overview.slice(0, 240)) }
  if (parsed && typeof parsed === "object" && Object.keys(parsed).length) {
    return header + "\\nFrom serena's language server — names only; find_symbol gives their lines:\\n" + overview.slice(0, 12000)
  }
  if (parsed) why.push("serena listed no declarations")
} catch (error) {
  why.push("serena: " + String(error).slice(0, 240))
}
return refusal + "\\n(No outline: " + why.join("; ") + ")"
`
}

/** What an answered grep starts with — and what `junon-usage.py` counts those answers by. */
const LOOKED_UP = "answered from the index by JUNON"

/**
 * The `execute` program opencode 2 runs in place of a grep for a bare identifier.
 *
 * The same question, put to the IDE's index first — `ide_find_symbol`, then `ide_hierarchy` for the
 * callers when exactly one callable carries the name — and to serena's language server when no IDE
 * answers. A name that is no symbol at all is a text search after all, so that answer is the refusal:
 * it says the same grep runs the second time, which it does. Everything the outline program measured
 * about `execute` holds here too.
 */
function lookupProgram(lookup: NonNullable<Decision["lookup"]>, refusal: string, directory: string | undefined): string {
  const header =
    `grep "${lookup.pattern}" ${LOOKED_UP}, not run — a bare identifier is a question about a ` +
    `symbol${lookup.scope ? `, and the index answers for the whole project, not only ${lookup.scope}` : ""}.\n` +
    `For its text occurrences too — comments, strings, config — run the same grep again: it runs the ` +
    `second time. A regex runs the first.\n`
  return `/* junon-first: lookup */
const pattern = ${JSON.stringify(lookup.pattern)}
const root = ${JSON.stringify(directory ?? "")}
const header = ${JSON.stringify(header)}
const refusal = ${JSON.stringify(refusal)}
const text = (answer) => {
  const value = answer && typeof answer === "object" && "result" in answer ? answer.result : answer
  return typeof value === "string" ? value : JSON.stringify(value)
}
const where = (uri) => {
  const path = decodeURIComponent(String(uri || "").replace(/^file:\\/\\//, ""))
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path
}
const line = (range) => ((range && range.start && range.start.line) || 0) + 1
const absent = refusal + "\\n(No answer from the index: serena is not in this turn's tool catalog — once it is connected, the next call has it.)"
if (typeof tools !== "object" || tools === null || tools.serena === undefined) return absent
const why = []
try {
  const answer = text(await tools.serena.ide_find_symbol({ query: pattern, limit: 30 }))
  let parsed
  try { parsed = JSON.parse(answer) } catch { why.push("the IDE: " + answer.slice(0, 240)) }
  if (parsed) {
    const symbols = Array.isArray(parsed.symbols) ? parsed.symbols : []
    // Exact names only: the index searches the way Go to Symbol does, and a near miss offered for a
    // config key would be an answer to a question nobody asked.
    const exact = symbols.filter((s) => ((s && s.locator) || {}).name === pattern)
    if (exact.length) {
      const rows = exact.slice(0, 20).map((s) => {
        const locator = s.locator || {}
        return "  " + (locator.kind || "symbol") + " " + locator.name + " — " + where(locator.documentUri) + ":" + line(s.range || locator.selectionRange)
      })
      let out = header + "\\nFrom the IDE's index — declared as " + pattern + ":\\n" + rows.join("\\n")
      if (exact.length === 1 && /^(method|function|constructor)$/.test(String(exact[0].locator.kind))) {
        try {
          const tree = JSON.parse(text(await tools.serena.ide_hierarchy({ name: pattern, relation: "callers" })))
          const callers = (tree.locations || []).slice(0, 20).map((c) => {
            const caller = (c.symbol && c.symbol.locator) || {}
            return "  " + (caller.name || "?") + " — " + where(c.location && c.location.uri) + ":" + line(c.location && c.location.range)
          })
          out += "\\n\\nIts callers, from the IDE" + (tree.truncated ? ", more than shown" : "") + ":\\n" + (callers.length ? callers.join("\\n") : "  none")
        } catch (error) {
          out += "\\n\\n(No callers: " + String(error).slice(0, 160) + ")"
        }
      }
      if (exact.length > 20 || parsed.truncated) out += "\\n(The IDE had more matches than shown.)"
      return out
    }
    why.push("the IDE's index has no symbol named " + pattern)
  }
} catch (error) {
  if (/Unknown tool/.test(String(error))) return absent
  why.push("the IDE: " + String(error).slice(0, 240))
}
try {
  const answer = text(await tools.serena.find_symbol({ name_path_pattern: pattern }))
  let parsed
  try { parsed = JSON.parse(answer) } catch { why.push("serena: " + answer.slice(0, 240)) }
  if (Array.isArray(parsed) && parsed.length) {
    const rows = parsed.slice(0, 20).map((s) => "  " + s.kind + " " + s.name_path + " — " + s.relative_path + ":" + (((s.body_location || {}).start_line || 0) + 1))
    return header + "\\nFrom serena's language server — no IDE answered:\\n" + rows.join("\\n")
  }
  if (Array.isArray(parsed)) why.push("serena has no symbol named " + pattern)
} catch (error) {
  why.push("serena: " + String(error).slice(0, 240))
}
// Both indexes answered, and neither knows the name: a text search after all. Advising the index
// here would send the agent to ask it again what it has just said.
if (why.length && why.every((reason) => / has no symbol named /.test(reason))) {
  return "grep \\"" + pattern + "\\" was not run: nothing in this project is declared as " + pattern +
    ", so it is a text search — run the same grep again and it runs.\\n(No answer from the index: " + why.join("; ") + ")"
}
return refusal + "\\n(No answer from the index: " + why.join("; ") + ")"
`
}

// --- the entry points ---------------------------------------------------------------------------

interface V1Context {
  readonly directory?: string
}

/** opencode 1's plugin: called once per project instance, its hook once per tool call. */
const opencode1 = async (ctx?: V1Context) => ({
  "tool.execute.before": async (input: any, output: any) => {
    // opencode 1 cannot change which tool runs, so an outline is not on offer here: it refuses.
    const decision = gate(1, input?.tool, (output?.args ?? {}) as Record<string, unknown>, input?.sessionID, ctx?.directory)
    if (decision !== undefined) throw new Error(decision.refusal)
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
      const decision = gate(2, event.tool, (event.input ?? {}) as Record<string, unknown>, event.sessionID, directory)
      if (decision === undefined) return
      // The call is answered rather than refused: the same question, put to JUNON.
      if (decision.outline !== undefined) {
        event.tool = "execute"
        event.input = { code: outlineProgram(decision.outline, decision.refusal) }
        return
      }
      if (decision.lookup !== undefined) {
        event.tool = "execute"
        event.input = { code: lookupProgram(decision.lookup, decision.refusal, directory) }
        return
      }
      throw new Error(decision.refusal)
    })
    return () => registration.dispose()
  },
}
