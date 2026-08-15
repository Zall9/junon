import type { Capability, IDEBPApplicationMethod } from "@ide-bridge/protocol";

/**
 * What this adapter tells the daemon it can do.
 *
 * Exported rather than built inline at the registration site so it can be checked against the
 * protocol's routed-method list: a method missing here is not a smaller capability set, it is a
 * consumer receiving no answer and no explanation. Anything unimplemented is declared
 * `unavailable` with a reason instead of being omitted.
 */
export const ADAPTER_CAPABILITIES: Readonly<Partial<Record<IDEBPApplicationMethod, Capability>>> =
  Object.freeze({
    "document/read": { support: "native" },
    "document/getRevision": { support: "native" },
    "document/getSymbols": { support: "provider", guarantee: "semantic" },
    "workspace/searchSymbols": { support: "provider", guarantee: "semantic" },
    "symbol/resolveAt": { support: "provider", guarantee: "semantic" },
    "symbol/getDefinition": { support: "provider", guarantee: "semantic" },
    "symbol/getReferences": { support: "provider", guarantee: "semantic" },
    "symbol/getImplementations": { support: "provider", guarantee: "semantic" },
    // All four relations, including `supertypes` — which the JetBrains adapter refuses, because
    // its platform has no language-neutral search for it. The protocol lets each adapter serve what
    // its IDE can, rather than levelling both down to the smaller set.
    "symbol/getHierarchy": { support: "provider", guarantee: "semantic" },
    // VS Code has no TODO index of its own; the marker search is a JetBrains platform service.
    // Declared unavailable with the reason rather than omitted.
    "workspace/searchTodos": {
      support: "unavailable",
      reason: "The VS Code adapter does not read TODO markers yet",
    },
    // Bookmarks are a JetBrains platform concept; VS Code's nearest equivalent is an extension.
    "workspace/listBookmarks": {
      support: "unavailable",
      reason: "The VS Code adapter does not expose bookmarks",
    },
    "diagnostics/getSnapshot": { support: "native" },
    // Served for `reformat` and `quickFix`. The other operations are refused by name at request
    // time rather than hidden behind an unavailable capability, so a consumer learns which one it
    // asked for was not wired. The guarantee is the weaker of the two the adapter can make.
    "refactor/prepare": { support: "provider", guarantee: "syntactic" },
    "refactor/prepareRename": {
      support: "provider",
      guarantee: "semantic",
      preview: true,
      atomicity: "text-only",
    },
    "workspace/applyPlan": { support: "native", atomicity: "text-only" },
    "workspace/discardPlan": { support: "native" },
    // The VS Code extension API exposes no way to revert an applied WorkspaceEdit. The
    // built-in undo command acts on the focused editor, which could be an unrelated
    // document, so claiming support would be worse than declaring none (ADR-0021).
    "workspace/undo": {
      support: "unavailable",
      reason: "VS Code exposes no API to revert an applied workspace edit",
    },
  } as Partial<Record<IDEBPApplicationMethod, Capability>>);
