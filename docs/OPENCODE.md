# opencode 1 and opencode 2

What differs between the two opencodes **for JUNON**, and what JUNON does about each difference.
Every row below was measured on a real machine — opencode **1.18.31** and **2.0.12**, each run in
isolation with a scripted model, or read from the live service and its session database — not taken
from either project's documentation. The machine this was written on moved from 1 to 2 on
2026-09-22; three JUNON defects surfaced within a day, all from assuming that what held under one
held under the other.

For setting a host up, see [AGENT_SETUP.md](AGENT_SETUP.md). This page is the reference it points
to when the answer depends on which opencode is running.

## At a glance

| | opencode 1.18 | opencode 2.0 |
| --- | --- | --- |
| MCP servers in `opencode.json` | `mcp.<name>` | `mcp.servers.<name>` |
| An MCP entry | `enabled: true`, `timeout: 60000` | `disabled: false`, `timeout: { startup, catalog, execution }` |
| Providers | `provider.<id>` with `npm`, `options` | `providers.<id>` with `package: "aisdk:…"`, `settings` |
| Permissions | `permission`: an object | `permissions`: a list of `{ action, resource, effect }` |
| npm plugins | `plugin` in `opencode.json` | `plugins` in `cli.json` |
| Local plugin files | `~/.config/opencode/plugin/*.ts` | the same directory |
| How a model reaches an MCP tool | as a tool of its own: `serena_find_symbol` | **only through `execute`**, as code: `await tools.serena.find_symbol({...})` |
| What a host asks an MCP server at open | `initialize`, `tools/list` | `initialize`, `tools/list`, **`prompts/list`** |
| Where MCP servers are started | per project | per project **and** in the service's own directory — `$HOME` |
| Shell tool | `bash` | `shell` |
| `read` / `edit` / `write` path argument | `filePath` | `path` |
| Plugin entry point | `default.server` — or exported functions if there is no default | `default.setup` |
| Tool hook | `"tool.execute.before"(input, output)` | `ctx.tool.hook("execute.before", event)` |
| The hook knows which agent asks | no | yes, `event.agent` |
| A hook can change which tool runs | no | yes — `event.tool` and `event.input` |
| `edit` needs a prior `read` of the file | a ranged `read` is enough | no |

## MCP tools are not tools in opencode 2

The difference that matters most, and the one that is easiest to miss because the server shows as
`connected` either way.

Under opencode 1 every MCP tool is offered to the model as a tool named `<server>_<tool>`, so JUNON's
`ide_status` is `serena_ide_status`. Under opencode 2 **no MCP tool is offered at all**. The model
gets one meta-tool, `execute`, runs code in it, and reaches MCP tools as `tools.<server>.<tool>` —
`tools["basic-memory-remote"].<tool>` when the name is not an identifier. It discovers them with
`search`:

```js
search({ query: "serena" })
return await tools.serena.find_symbol({ name_path_pattern: "UploadService/startWorkflow", include_body: true })
```

`search` is synchronous — opencode 2's own instructions to the model say to call it without `await`
(an `await` on it does no harm). The catalog `execute` is given is **fixed for the turn**: measured,
serena can be missing from a session's first turn while `ctx.mcp.list()` already reports it
`connected`, and present from the next. A server missing from the catalog still appears as
`tools.serena`; calling through it throws `Unknown tool 'serena.…'`. The sandbox has no `setTimeout`.

That is what the user's own opencode 2 sessions do, read back from `opencode.db` — including
`tools.serena.ide_status()` and `tools.serena.ide_symbols_overview(...)`.

Anything that names a tool to a model has to follow suit. The file-tool gate did not, and told
opencode 2 models to call `serena_find_symbol`, a tool they did not have; since 0.3.10 it writes each
refusal in the asking host's terms. Instruction files do the same — `~/.config/opencode/AGENTS.md`
gives both forms.

To count how often agents use JUNON under opencode 2, count `execute` calls whose code mentions
`tools.serena`, not tool calls named `serena_*`: there are none, and a count by name reads as zero.

## What each host asks an MCP server

Measured with a stdio tap between each host and `junon attach`, writing down every JSON-RPC message:

```
opencode 1.18   initialize → notifications/initialized → tools/list
opencode 2.0    initialize → notifications/initialized → tools/list → prompts/list   (every relay)
```

0.3.8 answered `initialize` and `tools/list` from a recorded handshake so that opening a session would
not start a project — and started the project to answer `prompts/list`, which only opencode 2 asks.
Since 0.3.9 the prompt list is recorded too. `tests/test_lazy_attach.py` replays each host's sequence
by name (`HOST_OPENING`), so a third host is one measured line away.

## Where opencode 2 starts MCP servers

opencode 2 starts each MCP server once in the directory its own service runs in, as well as once per
session location. `opencode serve --service` runs in `$HOME`, which is not a project, so `junon attach`
there has no root. Until 0.3.9 it exited, and **opencode 2 then marked the whole server failed in every
directory** — `serena failed: Connection closed` in `$HOME`, in real projects, everywhere. The relay
now stays up outside a project, offers no tools, and answers any call with what to do.

Ask the service rather than guessing:

```bash
opencode api GET /api/mcp --param directory=/path/to/project
opencode api POST /api/experimental/mcp/serena/connect --param location=/path/to/project   # reconnect in place
```

## Configuration traps

**`~/opencode.json` is a project configuration for everything under `$HOME`.** opencode walks up from
the project for `opencode.json`, so a file in the home directory applies to every repository below
it, and its entries override `~/.config/opencode/opencode.json` key by key (measured: MCP servers
defined only in the global file still started). The migration to opencode 2 left the opencode 1
home file in place, and its `serena` entry — plain `serena start-mcp-server` — silently replaced
`junon attach` in every session.

It cannot simply be deleted either: opencode 2 does not implement `instructions` yet, and
`legacy-instructions-compat.ts` restores it by reading **only** `opencode.json` files above the
project, resolving paths from the file's own directory. So `~/opencode.json` keeps `instructions`
and nothing else.

**opencode 2 lists npm plugins in `cli.json`.** Local plugin files are still picked up from
`~/.config/opencode/plugin/`.

## Writing a plugin for both

The shape both hosts load, measured by loading a traced copy into each:

```ts
export default {
  id: "my-plugin",
  server: async (ctx) => ({ "tool.execute.before": async (input, output) => { /* opencode 1 */ } }),
  async setup(ctx) { /* opencode 2: await ctx.tool.hook("execute.before", async (event) => { ... }) */ },
}
```

- **opencode 1.18 takes `server` whenever a default export exists, and then ignores named exports.**
  A named plugin beside a default holding only `setup` loads under opencode 1 and never runs — unit
  tests stay green, because they call the function directly.
- Each host runs the hook **once per tool call**. Do not de-duplicate by call id: models that number
  calls per message (Kimi's `functions.grep:0`) repeat the same id every turn.
- Import nothing from either host's plugin package. `Plugin.define` in opencode 2 is the identity
  function; a plain object is enough, and the file then loads under both.
- Refuse a call by throwing from the hook, in both hosts.
- opencode 2 also lets a hook **rewrite** a call: `event.tool` and `event.input` are mutable, and what
  `execute.after` reports is what ran (proved: `read` rewritten into `glob`, and into `execute`).
  The model gets the new call's output as the answer to the call it made, and **the database records
  the call it made** — a `read`, with its original input — holding the new call's output; the inner
  calls of a rewritten `execute` are in the part's `metadata.toolCalls`. `ctx.tool.transform` edits
  the tool list the model is offered.
- opencode 1 lets a hook change a call's arguments (`output.args`), not which tool runs.
- A plugin's `ctx.location.directory` is the session's project directory: opencode 2 sets a plugin up
  per location.

`integrations/agent-hosts/opencode/junon-first.ts` is the working example, and its tests go through
each host's entry point.

## Testing against both

A unit test proves the plugin does what its author believed the host does. Only the host proves the
belief. The recipe used for everything on this page:

- **opencode 1**: the 1.18.31 binary from the migration backup
  (`~/opencode-v1-backup-*/home/.opencode/bin/opencode`), isolated with `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and **`PWD`** — opencode 1 takes its directory
  from `PWD`, which changing the working directory from Python does not update. Drive it with
  `opencode run`; one `run` is one process, so a plugin's memory does not survive to the next.
- **opencode 2**: `opencode serve` with `OPENCODE_CONFIG_DIR`, `OPENCODE_DB` and
  `OPENCODE_SERVER_PASSWORD` (it otherwise makes one up), launched outside any project the way the
  service runs; drive it with `opencode api --server`. Responses are wrapped in `data`.
- **The model**: a small OpenAI-compatible HTTP server that returns scripted tool calls, declared as
  a provider in the isolated config. No credentials are needed, none are copied, and the tool result
  it receives back is exactly what a real model would read.
- **MCP traffic**: a stdio tap in front of `junon attach` that logs every message both ways, plus the
  relay's exit code and stderr.

**One thing that does not reproduce in isolation.** In a private `opencode serve`, even with a copy of
the real configuration, remote MCP servers reached the session's `execute` catalogue and local (stdio)
ones did not; the real service exposes both. It was not explained. So MCP routing is proved on the
real service — `opencode.db` records every `execute` and its code — and everything else in isolation.

## JUNON releases that followed from this page

| Release | Change |
| --- | --- |
| 0.3.9 | `prompts/list` answered from the recorded handshake; the relay stays up outside a project |
| 0.3.10 | the file-tool gate advises in each host's terms, loads under both, and every update installs it |
| 0.3.12 | a whole read of a large source file is never let through; opencode 2 answers it with the file's outline, by rewriting the `read` into an `execute` |
