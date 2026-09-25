# JUNON's IDE tools as opencode 2 tools, and the IDE after every edit

**Status:** in progress — see the [update log](#update-log).

## Why

Asked on 2026-09-25: *"ça continue de faire des read file et des write au lieu d'utiliser le mcp —
check pour des gates plus puissantes via les hooks que propose opencode V2."*

Under opencode 1 every MCP tool was a tool of its own. Under opencode 2 none is: a model reaches them
only by writing code for the `execute` tool after a `search` — and agents went back to `read` and
`grep`. Measured since 0.3.13: when they do reach serena they now ask the IDE first (`ide_read_symbol`
11, `ide_find_symbol` 4, against `find_symbol` 4), but 82 writes of source files went by with JUNON
nowhere in the loop.

## What opencode 2 gives a plugin — measured in the real host, 2026-09-25

| API | Measured |
| --- | --- |
| `ctx.tool.transform(registry)` | `list`, `get`, `add`, `update`, `remove`, `namespace`. Every tool is `{ id, name, description, input, output, options: { namespace, permission, codemode }, execute(args, context) }` |
| serena's tools in that registry | once serena connects: 39 of them, `serena_<tool>`, namespace `serena`, `codemode: true` |
| `codemode: false` on one | the model is offered it as a tool of its own from the next turn, and calling it works |
| an agent denied `serena_*` | offered none of them — oh-my-opencode-slim's per-agent `mcps` (written as `<server>_*` permissions) still hold |
| `registry.get(id).execute(...)` from a hook | the plugin calls serena itself — 104 ms for an outline |
| `execute.after` | `event.result.{output, content, metadata}`; changing `content` changes what the model reads |
| a tool the plugin `add`s | offered to the model, and called |
| inside `execute`, `tools.opencode` | session, model and MCP-resource tools only — no `read`, `edit` or `write` |
| a tool taken out of code mode | **gone from `execute`**: `tools.serena.ide_status` then throws "Unknown tool" — so the outline and grep programs, which call the IDE tools inside `execute`, would break, and so would agents' own `execute` calls to them (11 in the two hours measured) |
| the plugin calling serena after an `edit`, appending to its result | seen in the model's read-back: "Edited big.ts (1 replacement) … JUNON after this edit: …" |
| the IDE's `revision.contentHash` | equals `sha256:` of the file's bytes on disk — PhpStorm, `vod/core`, read-only |

Cost, measured on the request the model receives: the 13 IDE and symbol tools would add 17,419
characters of schema to a 13,620-character tool list — about 4,300 tokens on every request.

## Decisions

| Decision | Why |
| --- | --- |
| Seven IDE tools become opencode 2 tools of their own: `ide_status`, `ide_find_symbol`, `ide_read_symbol`, `ide_symbols_overview`, `ide_hierarchy`, `ide_read_document`, `ide_diagnostics` | The IDE first, as asked. 6,955 characters, not 17,419: serena's language-server tools (`find_symbol` alone is 3,680), `ide_refactor`, `ide_apply_fix` and `ide_todos` stay behind `execute`, and the gate's own answers fall back to the language server by themselves |
| `read`'s and `grep`'s descriptions name them | A model chooses a tool by its description |
| After an `edit` or `write` of a source file, the plugin asks the IDE for its diagnostics and appends the errors | The IDE in the write loop without an agent having to ask — the only place JUNON can stand in a write, since `execute` cannot write |
| …only when the IDE analysed **this** content: its `revision.contentHash` equals the SHA-256 of the file just written, and the analysis is complete | A diagnostic about the previous content is worse than none. Within a bounded wait, or nothing is appended |
| The outline and identifier-grep answers call serena from the plugin, and are handed back through an `execute` that only returns them | Required, not a nicety: a promoted tool is gone from `execute`, so the programs that called it there would break. And no more "serena is not in this turn's tool catalog" on a session's first turn |
| An `execute` whose code calls a promoted tool is refused, naming the tool to call instead | opencode 2's own error for it — "Unknown tool … Did you mean tools.serena.initial_instructions?" — points the wrong way |
| The advice under opencode 2 names the tools directly | They are tools of their own now; `execute` stays mentioned for the rest |

## Phases

### Phase 0 — measure the API and the two risks

**Status:** done 2026-09-25 — the tables above.

### Phase 1 — the IDE tools as tools, and descriptions that name them

**Status:** done 2026-09-25 — `promote`. Seen in the real opencode 2 with a private JUNON: from the
turn serena connected, exactly the seven were offered, `read` and `grep` carried the pointer, and a
direct `serena_ide_status` answered with the machine's real IDE state. An agent denied `serena_*`
was offered none, and its direct call was refused by the host.

**Acceptance:** in the real opencode 2, the seven tools are offered from the turn serena connects,
work when called, and are not offered to an agent denied `serena_*`; `read` and `grep` describe them.

### Phase 2 — the IDE after every edit

**Status:** done 2026-09-25 — `afterEdit`. Seen in the real opencode 2 on a project no IDE had:
an edit introducing `return notDeclaredAnywhere` came back with *"serena's language server reports
errors in this file after the edit … Cannot find name 'notDeclaredAnywhere'"*, and the edit undoing it
with *"finds no errors"*. For an agent denied serena, nothing — the host refused the plugin's calls.
The IDE path's freshness check was proved read-only (the hash above); its first real edit through an
IDE will show in `junon-usage.py`'s `checked` column, since no probe edits a real project.

**Acceptance:** after an edit of a source file, the errors the IDE (else the language server) finds
in the new content are appended, and nothing is appended when the analysed content is not the new
one; checked against a real IDE's hash without editing any real source.

### Phase 3 — answers without the execute detour

**Status:** done 2026-09-25 — `outlineAnswer` and `lookupAnswer` ask serena through the registry;
the answer goes back through an `execute` that only returns it. Seen in the real opencode 2: the
outline and the grep answer from serena's language server on a scratch project, and through the
machine's instance on `vod/core` with PhpStorm — the Pest file's outline with its coverage note. An
`execute` calling `tools.serena.ide_read_symbol` was refused with the redirect.

### Phase 4 — release

**Status:** pending

## Update log

| When | What |
| --- | --- |
| 2026-09-25 | Phases 1–3 done in the real opencode 2; opencode 1 and an opencode 2 without serena unchanged. |
| 2026-09-25 | Plan written, Phase 0 measured. |
