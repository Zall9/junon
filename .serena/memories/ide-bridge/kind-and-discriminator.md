# Symbol kinds, and why relocation no longer depends on them

## The finding

IntelliJ publishes **no typed, language-agnostic symbol classification**. `TreeElement` offers a
presentation — text and an icon — not a kind. So filling IDEBP's `SymbolKind` always requires either
per-language code or a heuristic. Deriving kind from presentation icons was considered and rejected:
language plugins wrap icons with visibility overlays, so identity matching is unreliable, and reading
a picture to decide a wire value is a guess whatever it is called.

Consequence: the JetBrains adapter reports `kind: "unknown"` for everything. `unknown` was added to
the protocol vocabulary for exactly this — a named declaration whose category the IDE does not expose.

## The design flaw this exposed

`SymbolRelocation` matched on `name` + `kind` + `containerName`, so relocating a stale handle
*depended* on a semantic classification no IDE publishes. That is the wrong tool: relocation needs a
**stable discriminator**, not a taxonomy.

## The fix

`SymbolLocator.declarationType` — opaque, adapter-defined, compared only for equality. The JetBrains
adapter fills it from `element.node.elementType`, the label the language's own parser assigned.
Relocation uses it when both sides carry one, falling back to `kind` otherwise (which keeps VS Code
working unchanged).

**Proven in PhpStorm**: a PHP class with a field `value` and a method `value()` comes back as
`CLASS_FIELD` and `CLASS_METHOD`, both `kind: unknown`. Only the discriminator separates them — the
exact case that would otherwise be `AMBIGUOUS_SYMBOL`.

## Confirmed across four IDEs

Since proven in three more, each with a vocabulary the adapter has never heard of:

| IDE | What `declarationType` carries |
| --- | --- |
| IntelliJ | `CLASS`, `METHOD`, `FIELD` |
| PhpStorm | `CLASS`, `CLASS_METHOD`, `CLASS_FIELD` |
| GoLand | `TYPE_SPEC`, `METHOD_DECLARATION`, `FIELD_DEFINITION` |
| PyCharm | `Py:CLASS_DECLARATION`, `Py:FUNCTION_DECLARATION`, `Py:TARGET_EXPRESSION` |

Nothing in the adapter branches on any of these strings, which is the whole point: a fifth IDE needs
no work. This is the no-language-code rule **observed**, not argued.

The `symbolKindMapper` extension point remains as an escape hatch, with **zero mappers shipped**:
bundling one puts that language's PSI in the jar, which the verifier reports as unresolvable in every
IDE without it.
