/**
 * Controlled relocation of stale symbol references (ADR-0003, amended by ADR-0018).
 *
 * A handle is a fast path bound to a session, an epoch, and — for document symbols — a revision.
 * When it no longer resolves, the locator is the durable identity. Relocation matches on the
 * locator's semantic fields (name, kind, containerName) inside its own document and uses the
 * selection range only to break ties. Matching on the locator fingerprint instead would fail for
 * any symbol shifted by a single line, which is precisely when a handle goes stale.
 *
 * Relocation never guesses: zero matches fail closed with `STALE_SYMBOL`, and several
 * indistinguishable matches fail closed with `AMBIGUOUS_SYMBOL` carrying every candidate.
 */

import type { Range, SymbolLocator } from "@ide-bridge/protocol";

import type { SymbolDraft } from "./symbol-mapper.js";

/** Mirrors the `AMBIGUOUS_SYMBOL` schema invariant: ambiguity means at least two candidates. */
export type AmbiguousCandidates = [SymbolLocator, SymbolLocator, ...SymbolLocator[]];

export type RelocationOutcome =
  | { kind: "resolved"; draft: SymbolDraft }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: AmbiguousCandidates };

/** Upper bound on candidates reported with `AMBIGUOUS_SYMBOL`. */
const MAX_AMBIGUOUS_CANDIDATES = 32;

export function relocateSymbol(
  locator: SymbolLocator,
  drafts: readonly SymbolDraft[],
): RelocationOutcome {
  const matches = collectMatches(locator, drafts);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) return { kind: "not-found" };
    return { kind: "resolved", draft: only };
  }

  // Same name, kind, and container: the original selection range is the only remaining
  // discriminator, and it is authoritative only when exactly one candidate still carries it.
  const exact = matches.filter((draft) =>
    sameRange(draft.locator.selectionRange, locator.selectionRange),
  );
  const single = exact.length === 1 ? exact[0] : undefined;
  if (single !== undefined) return { kind: "resolved", draft: single };

  const [first, second, ...rest] = matches
    .slice(0, MAX_AMBIGUOUS_CANDIDATES)
    .map((draft) => structuredClone(draft.locator));
  if (first === undefined || second === undefined) return { kind: "not-found" };
  return { kind: "ambiguous", candidates: [first, second, ...rest] };
}

function collectMatches(locator: SymbolLocator, drafts: readonly SymbolDraft[]): SymbolDraft[] {
  const matches: SymbolDraft[] = [];
  const pending = [...drafts];
  while (pending.length > 0) {
    const draft = pending.pop();
    if (draft === undefined) continue;
    if (isSameSymbolIdentity(draft.locator, locator)) matches.push(draft);
    pending.push(...draft.children);
  }
  return matches;
}

/**
 * Container name is compared as an optional field: a locator minted from a flat search result may
 * legitimately lack the container that the hierarchical document provider reports, so an absent
 * container on either side is treated as "unspecified" rather than as a mismatch.
 */
function isSameSymbolIdentity(candidate: SymbolLocator, target: SymbolLocator): boolean {
  if (candidate.documentUri !== target.documentUri) return false;
  if (candidate.name !== target.name || candidate.kind !== target.kind) return false;
  if (candidate.containerName === undefined || target.containerName === undefined) return true;
  return candidate.containerName === target.containerName;
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

/** Finds the innermost symbol whose declaration range contains `position`. */
export function findSymbolAtPosition(
  drafts: readonly SymbolDraft[],
  position: { line: number; character: number },
): SymbolDraft | undefined {
  let found: SymbolDraft | undefined;
  for (const draft of drafts) {
    if (!rangeContains(draft.range, position)) continue;
    found = findSymbolAtPosition(draft.children, position) ?? draft;
    break;
  }
  return found;
}

function rangeContains(range: Range, position: { line: number; character: number }): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}
