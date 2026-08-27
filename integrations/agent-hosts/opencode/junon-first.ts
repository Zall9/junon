import type { Plugin } from "@opencode-ai/plugin"
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
 * first five refusals went to it, naming a tool it could not call. The hook is given only
 * `{tool, sessionID, callID}`, so which agent is asking is not knowable here — but what the session
 * has *done* is, and that answers the same question without reading anyone's configuration.
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

export const JunonFirstPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      const args = (output?.args ?? {}) as Record<string, unknown>
      const session = String(input?.sessionID ?? "no-session")

      // Every call passes through here, which is what makes the session's own behaviour readable
      // without asking anyone: a session that reaches for a symbolic tool has them.
      if (tool.startsWith("serena")) {
        usesSymbolicTools.add(session)
        unheeded.set(session, 0)
        return
      }

      if (tool === "bash") {
        if (!worthNudging(session)) return
        const command = String(args.command ?? "")
        const words = firstWords(command)
        const searching = words.find((word) => SEARCH_COMMANDS.has(word))
        const reading = words.find((word) => READ_COMMANDS.has(word))
        if (!searching && !reading) return
        // What it is aimed at, not just what it is. Judging the verb alone refused
        // `cat .serena/project.yml` during a diagnosis — a config file, which this rule's own message
        // promises to let through. The tool-level rules were always careful here; this one was not.
        const segment = segmentFor(command, searching ? SEARCH_COMMANDS : READ_COMMANDS)
        if (!segment || !segmentAsksAboutSymbols(segment, Boolean(searching))) return

        const key = `${session}:bash:${command.slice(0, 120)}`
        if (alreadyNudged.has(key)) return
        alreadyNudged.add(key)
        unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

        throw new Error(
          `That command was not run: it uses \`${searching ?? reading}\` to answer a question the ` +
            `symbol index answers better, and running it through bash reaches the same dead end as ` +
            `the tool would.\n` +
            `  serena_find_symbol({ name_path_pattern: "…" })          where something is defined\n` +
            `  serena_find_referencing_symbols(...)                    who uses it\n` +
            `  serena_ide_read_symbol / serena_ide_read_document       from the running IDE\n` +
            `If the command is really about text or files — a log, a config, a build output — run it ` +
            `again and it will go through.`,
        )
      }

      if (tool !== "read" && tool !== "grep") return
      if (!worthNudging(session)) return

      if (tool === "grep") {
        const pattern = String(args.pattern ?? "")
        // A regex is a text search and this has no opinion about it. A bare identifier is a question
        // about a symbol, and grep answers it with every comment, string and unrelated name that
        // happens to contain it.
        if (!IDENTIFIER.test(pattern)) return

        const key = `${session}:grep:${pattern}`
        if (alreadyNudged.has(key)) return
        alreadyNudged.add(key)
      unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

        throw new Error(
          `grep "${pattern}" was not run. Ask the index instead — it resolves what a text search ` +
            `cannot:\n` +
            `  serena_find_symbol({ name_path_pattern: "${pattern}" })        the definition\n` +
            `  serena_find_referencing_symbols(...)                          real callers, including overrides\n` +
            `  serena_ide_find_symbol / serena_ide_hierarchy                 same, from the running IDE\n` +
            `If you genuinely want text — a log line, a config value, a string — run the same grep ` +
            `again and it will go through, or pass a regex.`,
        )
      }

      const path = String(args.filePath ?? args.path ?? "")
      if (!path || !CODE.test(path)) return
      // A range means the caller already knows what they want. Nothing to teach.
      if (args.offset !== undefined || args.limit !== undefined) return

      const lines = lineCount(path)
      const used = (spent.get(session) ?? 0) + 1
      spent.set(session, used)
      const overBudget = used > budgetFor(session)

      if (lines < WHOLE_FILE_IS_FINE && !overBudget) {
        // A project of small files was a way to read everything without ever being asked: each read
        // is under the threshold and the budget is never spent. One nudge per session closes it, and
        // only where there is something to teach.
        if (usesSymbolicTools.has(session) || nudgedAboutSmallFiles.has(session)) return
        nudgedAboutSmallFiles.add(session)
        unheeded.set(session, (unheeded.get(session) ?? 0) + 1)
        throw new Error(
          `read of ${path} was not run — this session has not asked the index anything yet, and a ` +
            `short file is still a file read whole:\n` +
            `  serena_ide_read_symbol({ ... })    one declaration, from the running IDE\n` +
            `  serena_find_symbol({ name_path_pattern: "…", include_body: true })\n` +
            `Said once per session. Run the same read again and it will go through, as will every ` +
            `short file after it.`,
        )
      }

      const key = `${session}:read:${path}`
      if (alreadyNudged.has(key)) return
      alreadyNudged.add(key)
      unheeded.set(session, (unheeded.get(session) ?? 0) + 1)

      if (overBudget && lines < WHOLE_FILE_IS_FINE) {
        throw new Error(
          `read of ${path} was not run — that is ${used} whole files opened in this session. Reading ` +
            `them one after another to find something is the search the symbol index does in one call:\n` +
            `  serena_find_symbol({ name_path_pattern: "…" })                 where it is defined\n` +
            `  serena_find_referencing_symbols(...)                           who uses it\n` +
            `  serena_search_for_pattern({ substring_pattern: "…" })          text, but scoped\n` +
            `Run the same read again and it will go through.`,
        )
      }

      throw new Error(
        `read of ${path} (${lines} lines) was not run — the whole file would enter the context to ` +
          `answer a question about part of it:\n` +
          `  serena_get_symbols_overview({ relative_path: "${path}" })                 what is in it\n` +
          `  serena_find_symbol({ name_path_pattern: "…", include_body: true })        one declaration\n` +
          `  serena_ide_read_document({ path: "${path}" })                             the file as the ` +
          `editor holds it, unsaved edits included — which the disk does not have\n` +
          `If you do need the raw file, pass offset/limit, or run the same read again and it will go through.`,
      )
    },
  }
}
