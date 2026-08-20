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

export const JunonFirstPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "read" && tool !== "grep") return

      const args = (output?.args ?? {}) as Record<string, unknown>
      const session = String(input?.sessionID ?? "no-session")

      if (tool === "grep") {
        const pattern = String(args.pattern ?? "")
        // A regex is a text search and this has no opinion about it. A bare identifier is a question
        // about a symbol, and grep answers it with every comment, string and unrelated name that
        // happens to contain it.
        if (!IDENTIFIER.test(pattern)) return

        const key = `${session}:grep:${pattern}`
        if (alreadyNudged.has(key)) return
        alreadyNudged.add(key)

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
      if (lines < WHOLE_FILE_IS_FINE) return

      const key = `${session}:read:${path}`
      if (alreadyNudged.has(key)) return
      alreadyNudged.add(key)

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
