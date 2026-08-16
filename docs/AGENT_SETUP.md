# Setting this up, for a coding agent

You are setting up three processes that must find each other: a **daemon**, at least one **IDE
adapter** connected to it, and a **consumer** (JUNON on Serena, or your own client). The daemon is
the fixed point — start it first, and everything else discovers it through one file.

Work through the steps in order. Each one ends with something to check. **Do not proceed on a step
whose check you did not see pass**: every hard-to-diagnose failure in this project's history came
from assuming a step worked, and the failures below are silent by nature — a wrong daemon answers
just as promptly as the right one.

---

## 0. Preconditions

| | |
| --- | --- |
| Node | 24 (`node --version`) |
| pnpm | 10 (`pnpm --version`) |
| Python | ≥ 3.12, only for the Serena integration |
| JDK 21 + Gradle ≥ 9 | only for the JetBrains adapter |

macOS and Linux. The discovery file is written with POSIX permissions and Windows is not supported.

## 1. Build

```bash
pnpm install
pnpm -r build
```

**Check:** `packages/cli/dist/bin.js` exists. Everything below runs it directly; there is no global
install and you should not add one.

## 2. Start the daemon

Pick one discovery file and export it in **every** shell you use afterwards. This is the single most
common source of confusion: two shells with different values are two daemons.

```bash
export IDE_BRIDGE_DISCOVERY_FILE=/tmp/ide-bridge.json
node packages/cli/dist/bin.js daemon
```

Leave it running. It writes its endpoint and token to that path, mode `0600`. Unset, the default is
`~/.ide-bridge/discovery.json`.

**Check**, from a second shell with the same variable exported:

```bash
node packages/cli/dist/bin.js status
```

`{"ok":true,...,"adapterCount":0,"workspaceCount":0}` — zero is correct here; no IDE has connected
yet.

## 3. Identify the daemon before trusting it

```bash
node packages/cli/dist/bin.js doctor
```

Read the `daemon` block, not just the checks: `pid`, `discoveryFile`, `startedAt`, `uptimeSeconds`.

**Check:** the pid is the process you just started, and the uptime is seconds — not hours. A daemon
left running from an earlier session passes every check and answers every request, and telling the
two apart afterwards is nearly impossible. If the uptime is large and you did not intend that, stop
the old one before going on.

## 4. Attach an IDE

Do one of the two. Both can run at once against the same daemon — that is a supported configuration,
not a hack.

### JetBrains

```bash
cd jetbrains-plugin
export IDE_BRIDGE_DISCOVERY_FILE=/tmp/ide-bridge.json    # the plugin reads this
export IDE_BRIDGE_SAMPLE_PROJECT=$PWD                    # or any project with source roots
./gradlew runIde                                          # runPyCharm / runGoLand / runPhpStorm too
```

For an IDE you already have, `./gradlew buildPlugin` produces
`build/distributions/ide-bridge-jetbrains-*.zip`; install it with *Settings → Plugins → Install from
disk*. The IDE must then be launched from a shell that exports the variable — an IDE started from
the Dock or a launcher inherits none of it and will look at the default path instead.

A project **links itself when it opens**; there is nothing to click. The *IDE Bridge* tool window
shows one row per open project with its state, and a refusal states its reason there and in the log.

**The project must declare source roots.** A directory opened with none has no index and no
analyser, and the adapter says so rather than returning empty answers that look like real ones.

### VS Code

```bash
cd packages/vscode-extension
pnpm package        # dist/ide-bridge.vsix; install with: code --install-extension dist/ide-bridge.vsix
```

The extension does **not** take its configuration from the environment the same way: it reads the
`ideBridge.discoveryFile` setting first, and only falls back to `IDE_BRIDGE_DISCOVERY_FILE` when that
setting is empty. Set the setting when in doubt. `ideBridge.autoStartDaemon` is `true` by default, so
an editor that finds no daemon will start one of its own — convenient, and a second way to end up
talking to a daemon you did not start.

To verify the whole adapter without wiring anything, `pnpm test:integration` downloads VS Code,
installs the extension, opens a fixture project and drives the walkthrough itself.

**Check**, from your shell:

```bash
node packages/cli/dist/bin.js adapters
node packages/cli/dist/bin.js workspaces
```

`adapters` must list the IDE build you just started, and `workspaces` the project you opened. If
`adapters` is empty, the IDE is looking at a different discovery file — go back to step 2 rather than
restarting things at random.

## 5. Connect Serena (JUNON)

JUNON composes onto an **unmodified** Serena, so it must be installed into Serena's own environment:

```bash
pipx inject serena-agent integrations/serena --include-apps     # if Serena came from pipx
uv tool install serena-agent --with integrations/serena          # if it came from uv tool
```

**Check:**

```bash
junon tools list | grep '^ \* `ide_'
```

Nine tools. Zero means plain Serena answered.

Then configure your MCP host to run **`junon`**, never `serena`:

```json
{
  "type": "stdio",
  "command": "junon",
  "args": ["start-mcp-server", "--project-from-cwd", "--transport", "stdio"]
}
```

This is the one step with no error message when you get it wrong. `serena` still starts plain Serena
— deliberately, so that installing JUNON cannot change a machine's behaviour silently — which means a
host pointed at `serena` gets the same tool names, no `ide_*` tools, no dashboard, and no complaint.
Most MCP hosts read this configuration at start-up only: restart the session after changing it.

## 6. Verify end to end

Call `ide_status` through your agent. It reports whether an IDE is connected and what it has open.
That is the only check that exercises the whole chain — consumer, daemon, adapter, IDE — and it is
the one to run before concluding that anything else is broken.

---

## When something does not work

| Symptom | Cause to check first |
| --- | --- |
| `adapterCount: 0` with an IDE running | The IDE and your shell are using different discovery files |
| Everything passes but answers look stale or wrong | A daemon from an earlier session. `doctor`, and read `pid` and `uptimeSeconds` |
| Agent has no `ide_*` tools | The host is running `serena`, not `junon` |
| `ide_*` tools exist but every call refuses | No adapter connected, or the workspace is not the one the IDE has open |
| Empty symbol results on a real project | The project declares no source roots; the adapter reports this rather than guessing |
| No JUNON dashboard link in the JetBrains panel | Nothing published one — the panel now says so in place of the link |
| A file changed on disk is not visible to reads | Up to ~15 s: an unfocused IDE only refreshes when asked, and the adapter asks on a timer |

## Rules that are not yours to relax

- The daemon binds loopback only. Do not expose it, tunnel it, or bind it to another interface.
- Never log or echo the token, and never paste the discovery file into an issue or a commit.
- No method executes shell commands or evaluates code in the IDE. If a task seems to need that, it
  is out of scope — say so rather than adding it.
- Do not modify `TASK.md`; it is the authoritative scope.
- Never push, publish, open a PR, or touch any remote.

`AGENTS.md` holds the full development rules, [STATUS.md](STATUS.md) what is actually verified, and
[DEMO.md](DEMO.md) the same walkthrough with each step's measured output.
