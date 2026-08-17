# JUNON — the IDE Bridge integration for Serena

JUNON gives Serena a semantic backend that answers from a **running IDE** — IntelliJ, PyCharm or VS
Code — through the IDE Bridge daemon, instead of from a language server it starts itself.

It is applied to Serena **without editing it**. Nothing in Serena's tree is patched, forked or
vendored: Serena is imported, a handful of named attributes are rebound to subclasses, and then
Serena runs. `pip install -U serena-agent` stays conflict-free because there is nothing of ours in
their tree for a merge to fight over. What that costs in return is a dependency on internals upstream
never promised to keep, which is why those seams are pinned by a test (see *Compatibility* below).

## Installing it when you already have Serena

JUNON has to live **in the same environment as Serena**, because it imports it. The package declares
`aenum`, `websockets` and `psutil` as dependencies — Serena is expected to be there already, not
installed alongside as a second copy. `psutil` is named even though Serena's own tree already brings
it, because a guarantee resting on someone else's transitive dependency is one upstream can drop
without ever knowing it was load-bearing.

If Serena came from `pipx`:

```bash
pipx inject serena-agent /path/to/ide-bridge/integrations/serena --include-apps
```

`--include-apps` is what puts `junon` on your `PATH`; without it the package is installed and the
command is unreachable. Add `-e` to track a checkout instead of taking a copy.

If Serena came from `uv tool`:

```bash
uv tool install serena-agent --with /path/to/ide-bridge/integrations/serena
```

And if Serena is in a virtualenv you manage yourself, `pip install` into **that** environment — not
into a fresh one.

Verified on this repository: injected into a `pipx` install of upstream **Serena 1.5.3**, the install
adds exactly `aenum`, `websockets` and `ide_bridge`, upgrades nothing, and `pip check` stays clean.

## Running it

```bash
junon start-mcp-server --project-from-cwd --transport stdio
```

`junon` composes and then hands the process to Serena's own CLI, unchanged — every Serena argument,
subcommand and flag keeps working, and nothing here has to track them.

**Configure your agent host to run `junon`, not `serena`.** This is the one mistake the design makes
easy to make and hard to see: `serena` still starts plain Serena, on purpose, so that a machine with
this package installed does not silently behave differently. The failure is therefore silent in the
other direction — a host configured for `serena` gets no `ide_*` tools, no JUNON dashboard, and no
error message saying so. It has happened here. The IDE panel now says *"JUNON dashboard: none running
— Serena was started as `serena`, not `junon`"* rather than hiding its link, for exactly this reason.

## Checking that it took

Composition is reported rather than assumed, because every step can fail in a way that leaves Serena
working perfectly and the customisation absent:

```bash
junon tools list | grep '^ \* `ide_'
```

Nine tools should be listed — `ide_status`, `ide_diagnostics`, `ide_find_symbol`, `ide_read_symbol`,
`ide_read_document`, `ide_symbols_overview`, `ide_hierarchy`, `ide_apply_fix`, `ide_todos`. Measured
on Serena 1.5.3 with all four seams present and `Composition(tools_package_added=True,
dashboard_rebound=True)`. In the same environment, plain `serena` reports **zero** `ide_*` tools and
keeps `SerenaDashboardAPI` — the separation is real, not a claim.

A started JUNON also announces its dashboard in `~/.ide-bridge/dashboards/<pid>.json`, which is how
the JetBrains tool window offers a link to a port it cannot otherwise guess. A clean exit removes the
entry; a crash leaves it, and readers drop what they find dead. The entry records when the process
started as well as its pid, because pids are reused and these files outlive their processes — a
reader that trusted the pid alone would eventually offer a link to whatever inherited the number.

## Getting a change into the thing that is running

Editing a source file here changes nothing that is running. Two halves of this integration are
deployed in two different ways, and only one of them updates by itself:

- **The Python side** is usually an *editable* install (`pipx inject … -e`, the `-e` in the command
  above), so the injected package is a pointer to a checkout rather than a copy of it. Check where
  that pointer goes before assuming it is the tree you are editing — a worktree on a branch is not
  the checkout it was made from:

  ```bash
  python -c "import junon.dashboard_registry as m; print(m.__file__)"
  ```

  Run it with the interpreter Serena uses (`~/.local/pipx/venvs/serena-agent/bin/python` for a pipx
  install), not the one on your `PATH`. A change lands on the next **JUNON restart**; a running agent
  keeps the module it imported at start-up.

- **The JetBrains plugin** is a built jar, so a source change reaches an IDE only by rebuilding and
  reinstalling it:

  ```bash
  cd jetbrains-plugin && ./gradlew buildPlugin
  ```

  Then *Settings → Plugins → ⚙ → Install Plugin from Disk* with
  `build/distributions/ide-bridge-jetbrains-*.zip`, **in each IDE separately** — an install in GoLand
  is invisible to PhpStorm — and restart the IDE.

The halves read and write the same registry file, so an update that lands on one side and not the
other is the failure this arrangement invites. When a field changes shape, deploy both.

**A registry entry written by an older JUNON is trusted on its pid alone**, by design: dropping
entries that predate a field would blank the tool window for every JUNON running at the moment of an
upgrade. Those entries therefore keep the weakness the field exists to remove, and no reader can
retire them for you. Clear them once, while nothing is running:

```bash
rm -f ~/.ide-bridge/dashboards/*.json
```

## Compatibility

The seams JUNON rebinds — `serena.tools.tools_base.tool_packages`, `serena.agent.SerenaDashboardAPI`,
`serena.cli.top_level`, `serena.constants.SERENA_DASHBOARD_DIR` — are pinned by
`tests/test_upstream_seams.py`. When an upstream release moves one, that test fails and names it,
instead of producing something inexplicable at runtime. Composition is checked against Serena 1.5.3
and 1.7.1.dev0.

An incomplete composition is logged and **not** fatal: a JUNON that could not attach is a Serena that
still works, and refusing to start would turn a cosmetic failure into an outage.

## Removing it

```bash
pipx uninject serena-agent ide_bridge
```

Serena is unaffected — it was never modified.

## Layout

```
integrations/serena/
├── junon/                  # The composition: what is applied to Serena, and in which order
│   ├── __main__.py         # The `junon` command: compose, then hand over to Serena's CLI
│   ├── compose.py          # Every rebinding, with the constraint each one carries
│   ├── tools.py            # The ide_* tools Serena discovers alongside its own
│   ├── dashboard.py        # Serena's dashboard, with JUNON's pages added
│   ├── dashboard_registry.py  # How a running dashboard announces itself to the IDE
│   └── client.py           # The daemon's WebSocket client, synchronous by design (ADR-0036)
├── ide_bridge/             # Protocol-facing models and configuration, no Serena imports
└── tests/
```

## Tests

```bash
python3 -m pytest                      # unit tests
python3 -m pytest -m integration       # requires a live IDE Bridge daemon
```
