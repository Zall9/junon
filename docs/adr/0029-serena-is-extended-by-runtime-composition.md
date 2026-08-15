# ADR-0029: Serena is extended by runtime composition, never by editing it

- Status: accepted
- Date: 2026-08-09
- Related: [ADR-0025](0025-cross-language-uri-vectors.md), [ADR-0028](0028-structural-refactorings-are-refused-not-approximated.md)

## Context

TASK.md §21 requires a Serena integration and offers two shapes: a clean patch against a fork, or a
standalone Python package with integration instructions. §31 makes the integration a condition of
the project being finished.

The governing requirement came from the product owner and is stronger than either: **it must always
be possible to update Serena completely.** Not usually, not with a manageable merge — always.

That eliminates the patch. A patch is a bet that upstream will not touch the lines it depends on,
and the bet is lost silently, at the worst moment, by whoever runs the update. It also eliminates a
fork with edits, for the same reason at larger scale.

So: **nothing under `serena-upstream/` is ever modified.** Serena is imported unmodified, a handful
of named attributes are rebound to our subclasses, and it runs. There is nothing of ours in their
tree for a merge to fight over.

## What this costs

We depend on internals upstream never promised to keep. That is the real price, and it is only
acceptable because the failure is made **loud and named**: `tests/test_upstream_seams.py` pins every
seam we reach into, so an update that moves one fails there — pointing at it — rather than producing
something inexplicable at runtime three layers away.

The product owner's framing was the right one: if the tests are thorough enough, breakage is always
detected. That is the whole safety mechanism, and it is why the seam tests are not optional
scaffolding.

## Decision

Three seams, and the order they are applied in matters.

**The tool package is registered first.** `ToolRegistry` is decorated `@singleton`: the first call
builds the instance from whatever `tool_packages` held at that moment and caches it forever. Append
afterwards and our tools are simply missing — no exception, nothing logged, just absent.

**The dashboard is a subclass, rebound by module attribute.** Every upstream route registers
untouched; we then replace three view functions *by endpoint name*. Re-registering the URL rule
instead would leave resolution to werkzeug's ordering, which is not something to bet a UI on.
Serena's own dashboard stays reachable at `/serena-dashboard/`, because a fallback you can open is
worth more than a theoretical one.

**Existing tools are served by replacing `apply` on Serena's own classes.** Tool names derive from
class names and a duplicate raises at registry construction — which would take the agent down, not
just our tools — so defining our own `FindSymbolTool` is not available. Overriding the method keeps
the name, the registration and the enabling rules exactly as upstream defines them, and changes only
what runs. New capabilities with no upstream equivalent (hierarchies, TODOs, bookmarks, quick fixes)
are added as genuinely new tools through `tool_packages`, which is a seam designed to be extended.

## Alternatives rejected, each after measuring it

**Extending `LanguageBackend` with an `IDE_BRIDGE` member.** This *works* — `aenum.extend_enum` adds
it and `LanguageBackend.from_str("ide_bridge")` resolves it, both verified. It was the approved
direction until the dispatch was measured: Serena branches on `is_lsp()` / `is_jetbrains()` in at
least five places, as binary `if/elif`, with no third path. A third member takes none of them. The
agent initialises no backend, `tools_base.py` asserts `is_lsp()` on the symbol retriever, and
`project.py`, `query_project_tools.py` and `file_proxy.py` all skip us.

So the member buys the **name** and not the behaviour. Shipping a `language_backend: ide_bridge` that
resolves and then does nothing would be a lie in the user's configuration file, so the extension was
removed rather than kept. This is a deviation from §21's letter, which specifies exactly that value;
it is recorded here rather than quietly dropped.

**A façade impersonating Serena's JetBrains plugin.** Serena talks to its own plugin over 18 HTTP
endpoints discovered by port scan, and implementing them would inherit an entire working tool suite
(`jetbrains_tools.py`) plus `query_project_tools` and `file_proxy`, unmodified — and would bring
multi-IDE, since that plugin is JetBrains-only while ours would reach VS Code too. It is the most
capable option and it was seriously considered.

It was rejected for what it requires in exchange: the client calls `is_version_at_least`, so we would
have to **claim a version of someone else's component** and thereby inherit expectations we may not
meet. Announce too high and Serena enables what we do not serve; too low and it disables what we do.
That is a permanent, unbounded coupling, paid to avoid a handful of named and tested `setattr` calls.
The risk of colliding with a real plugin installation was raised and dismissed by the product owner —
that environment will not have one — but the version mimicry is not addressed by that.

## Consequences

Users configure `language_backend: LSP` and get IDE Bridge behaviour through overridden tools, rather
than naming a backend that does not exist. The deviation from §21 is documented above.

If upstream ever grows a real backend registry, this ADR should be revisited: a designed seam beats
three undesigned ones, and contributing that upstream is the only route that stops depending on
internals altogether.
