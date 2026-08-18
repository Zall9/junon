# Using the `ide_*` tools

The MCP you are connected through is **JUNON** — `junon start-mcp-server`, not plain `serena`. It
registers ten `ide_*` tools alongside Serena's own, and they answer from the **running IDE** instead
of from disk. Plain `serena` publishes none of them; if you cannot see them, the host was configured
for the wrong command.

**Call `ide_status` first.** It says whether an IDE is connected and what it has open. Every other
`ide_*` tool refuses without one, and the refusal names its reason.

Prefer them over reading and searching files:

- `ide_read_document` — the file **as the editor holds it**, unsaved edits included. Reading from
  disk gives a different file whenever someone is typing.
- `ide_read_symbol` — one declaration's source, cut to the range the IDE gives it.
- `ide_symbols_overview` — a file's top-level symbols, from the language engine.
- `ide_find_symbol` — the IDE's symbol index, narrowed by kind. A text search matches comments,
  strings and unrelated names; this does not.
- `ide_hierarchy` — callers, callees, supertypes, subtypes. A search cannot resolve an override.
- `ide_diagnostics` — the IDE's own inspections, with the fixes it offers.
- `ide_todos` — TODOs as the IDE recognises them, not as a search guesses at them.
- `ide_apply_fix` — applies one fix `ide_diagnostics` offered. `confirm` separates looking from
  doing. **Not a general editor.**

**Where this stops.** Writing new code is still an ordinary file edit. The division is: ask the IDE
what is true, edit with your own tools, then ask `ide_diagnostics` what you broke.

**A refusal is a finding.** This repository builds the thing you are calling. If a route refuses when
it should not, or answers something a file read contradicts, report it — that is worth more than the
task it interrupted. When you fall back to reading files, say so, so a result nothing verified is
never mistaken for one the IDE confirmed.
