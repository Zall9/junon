import { isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
import type {
  DocumentDiagnostics,
  EditPlan,
  ModifiedDocument,
  DocumentReference,
  Range,
  Symbol as IDEBPSymbol,
  SymbolLocation,
  Workspace,
} from "@ide-bridge/protocol";

/**
 * Rules every adapter must satisfy, whatever IDE is behind it.
 *
 * Conformance cannot demand identical answers: VS Code and JetBrains run different providers over
 * different languages, and a suite that compared outputs literally would fail on differences that
 * are correct. What it can demand is that the *shape* of an answer holds — a range that runs
 * backwards, a URI outside every root, or a handle bound to another session is wrong on any IDE.
 *
 * Each rule here is one that has already cost something. The handle-binding rule is what the daemon
 * closes a session over; the containment rule is what makes a response a policy violation; the
 * truncation rule is what separates "this document is clean" from "nobody looked".
 */

export interface Violation {
  readonly rule: string;
  readonly detail: string;
}

export interface SymbolResponseSubject {
  readonly workspace: Workspace;
  readonly adapterId: string;
  readonly sessionId: string;
  /** The document the consumer asked about. */
  readonly requestedUri: string;
  readonly document: DocumentReference;
  readonly symbols: readonly IDEBPSymbol[];
}

export interface SymbolSearchSubject {
  readonly workspace: Workspace;
  readonly adapterId: string;
  readonly sessionId: string;
  /** The ceiling in force for this request, after the protocol's own cap. */
  readonly limit: number;
  readonly symbols: readonly IDEBPSymbol[];
  readonly truncated: boolean;
}

export interface SymbolLocationsSubject {
  readonly workspace: Workspace;
  readonly adapterId: string;
  readonly sessionId: string;
  /** Which method produced these — named only so a violation says where it came from. */
  readonly method: string;
  readonly locations: readonly SymbolLocation[];
  readonly truncated: boolean;
}

export interface DiagnosticsResponseSubject {
  readonly workspace: Workspace;
  readonly documents: readonly DocumentDiagnostics[];
  readonly truncated: boolean;
  /** Ceiling the adapter is allowed to apply per document. */
  readonly perDocumentLimit: number;
}

const wellFormed = (range: Range): boolean =>
  range.start.line < range.end.line ||
  (range.start.line === range.end.line && range.start.character <= range.end.character);

const contains = (outer: Range, inner: Range): boolean => {
  const startsBefore =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const endsAfter =
    inner.end.line < outer.end.line ||
    (inner.end.line === outer.end.line && inner.end.character <= outer.end.character);
  return startsBefore && endsAfter;
};

const withinAnyRoot = (uri: string, workspace: Workspace): boolean =>
  workspace.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri));

/**
 * Checks a `document/getSymbols` response.
 *
 * Walks the whole tree: a nested symbol that breaks a rule is as wrong as a top-level one, and
 * checking only the roots is how a defect stays hidden behind a correct-looking first level.
 */
export function checkDocumentSymbols(subject: SymbolResponseSubject): Violation[] {
  const violations: Violation[] = [];
  const seenHandles = new Set<string>();

  if (subject.document.uri !== subject.requestedUri) {
    violations.push({
      rule: "document.matches-request",
      detail: `answered for ${subject.document.uri}, was asked for ${subject.requestedUri}`,
    });
  }
  if (subject.document.workspaceId !== subject.workspace.workspaceId) {
    violations.push({
      rule: "document.belongs-to-workspace",
      detail: `document claims workspace ${subject.document.workspaceId}`,
    });
  }
  if (subject.document.revision.workspaceEpoch !== subject.workspace.workspaceEpoch) {
    violations.push({
      rule: "document.current-epoch",
      detail: `revision epoch ${subject.document.revision.workspaceEpoch} is not the workspace's`,
    });
  }

  const walk = (symbol: IDEBPSymbol, depth: number): void => {
    const where = `${symbol.locator.name} (depth ${depth})`;

    if (symbol.handle.adapterId !== subject.adapterId) {
      violations.push({ rule: "handle.bound-to-adapter", detail: where });
    }
    if (symbol.handle.sessionId !== subject.sessionId) {
      // The daemon treats this as a protocol violation and closes the session.
      violations.push({ rule: "handle.bound-to-session", detail: where });
    }
    if (symbol.handle.validUntilEpoch !== subject.workspace.workspaceEpoch) {
      violations.push({ rule: "handle.bound-to-epoch", detail: where });
    }
    if (seenHandles.has(symbol.handle.id)) {
      violations.push({ rule: "handle.unique-in-response", detail: where });
    }
    seenHandles.add(symbol.handle.id);

    if (!wellFormed(symbol.range)) {
      violations.push({ rule: "range.well-formed", detail: where });
    }
    if (!wellFormed(symbol.locator.selectionRange)) {
      violations.push({ rule: "selection-range.well-formed", detail: where });
    }
    if (!contains(symbol.range, symbol.locator.selectionRange)) {
      // A rename replaces the selection range; outside the declaration it rewrites the wrong text.
      violations.push({ rule: "selection-range.within-declaration", detail: where });
    }
    if (symbol.locator.documentUri !== subject.requestedUri) {
      violations.push({ rule: "locator.same-document", detail: where });
    }
    if (!withinAnyRoot(symbol.locator.documentUri, subject.workspace)) {
      violations.push({ rule: "locator.within-a-root", detail: where });
    }
    if (symbol.locator.name.trim().length === 0) {
      violations.push({ rule: "locator.named", detail: `depth ${depth}` });
    }

    for (const child of symbol.children) walk(child, depth + 1);
  };

  for (const symbol of subject.symbols) walk(symbol, 0);
  return violations;
}

/** Checks a `diagnostics/getSnapshot` response. */
/**
 * Checks any response carrying symbol locations: definition, references, implementations, and a
 * hierarchy step.
 *
 * They share one shape deliberately, so they share one rule. A hierarchy that answered with a URI
 * outside every root, or a handle from another session, would be wrong for exactly the reasons a
 * lookup would — and until this existed, the newest of the four had no contract check at all.
 */
export function checkSymbolLocations(subject: SymbolLocationsSubject): Violation[] {
  const violations: Violation[] = [];
  const seenHandles = new Set<string>();

  for (const entry of subject.locations) {
    const where = `${subject.method} → ${entry.location.uri}`;

    if (!wellFormed(entry.location.range)) {
      violations.push({ rule: "location.range-well-formed", detail: where });
    }
    if (!withinAnyRoot(entry.location.uri, subject.workspace)) {
      violations.push({ rule: "location.within-a-root", detail: where });
    }

    const symbol = entry.symbol;
    if (symbol === undefined) continue;

    if (symbol.handle.adapterId !== subject.adapterId) {
      violations.push({ rule: "handle.bound-to-adapter", detail: where });
    }
    if (symbol.handle.sessionId !== subject.sessionId) {
      violations.push({ rule: "handle.bound-to-session", detail: where });
    }
    if (symbol.handle.validUntilEpoch !== subject.workspace.workspaceEpoch) {
      violations.push({ rule: "handle.current-epoch", detail: where });
    }
    if (seenHandles.has(symbol.handle.id)) {
      violations.push({ rule: "handle.unique", detail: where });
    }
    seenHandles.add(symbol.handle.id);

    if (!withinAnyRoot(symbol.locator.documentUri, subject.workspace)) {
      violations.push({ rule: "locator.within-a-root", detail: where });
    }
  }

  // An empty result that claims truncation says the adapter capped a list it never filled, which is
  // the one combination that cannot be true.
  if (subject.truncated && subject.locations.length === 0) {
    violations.push({
      rule: "truncation.implies-results",
      detail: `${subject.method} reported truncation with no locations`,
    });
  }

  return violations;
}

/**
 * Checks a `workspace/searchSymbols` response.
 *
 * This route went several increments with no rule of its own, which is how it came to drop a
 * declaration silently while reporting a complete answer (ADR-0030, ADR-0031). The rules are ADR-0017's
 * own: a hit is a symbol like any other, so its geometry and its handle binding are judged exactly as
 * `checkDocumentSymbols` judges a document's — reusing those rule names deliberately, because a
 * backwards range is the same defect wherever it appears.
 *
 * Two things differ from a document's symbols, both because a search spans documents rather than
 * describing one:
 *
 * - **A hit carries no children.** The result is flat by decision, so nesting here would be a shape no
 *   consumer is prepared to walk.
 * - **`truncated` with nothing in the list is legitimate.** The opposite rule holds for lookups, where
 *   an empty truncated result claims a cap on a list never filled. A search can genuinely reach a
 *   ceiling before it matches anything: the JetBrains adapter stops after `MAX_SCANNED_NAMES` names,
 *   and ADR-0017 requires an in-scope hit it cannot represent to be reported through `truncated`
 *   rather than vanish — either can leave an empty list that is truthfully incomplete.
 */
export function checkSearchSymbols(subject: SymbolSearchSubject): Violation[] {
  const violations: Violation[] = [];
  const seenHandles = new Set<string>();

  for (const symbol of subject.symbols) {
    const where = `${symbol.locator.name} in ${symbol.locator.documentUri}`;

    if (symbol.handle.adapterId !== subject.adapterId) {
      violations.push({ rule: "handle.bound-to-adapter", detail: where });
    }
    if (symbol.handle.sessionId !== subject.sessionId) {
      violations.push({ rule: "handle.bound-to-session", detail: where });
    }
    if (symbol.handle.validUntilEpoch !== subject.workspace.workspaceEpoch) {
      violations.push({ rule: "handle.bound-to-epoch", detail: where });
    }
    if (seenHandles.has(symbol.handle.id)) {
      violations.push({ rule: "handle.unique-in-response", detail: where });
    }
    seenHandles.add(symbol.handle.id);

    // Flat by decision: a consumer reading a search result walks a list, not a tree.
    if (symbol.children.length > 0) {
      violations.push({ rule: "search.hits-are-flat", detail: where });
    }
    if (!withinAnyRoot(symbol.locator.documentUri, subject.workspace)) {
      violations.push({ rule: "locator.within-a-root", detail: where });
    }
    if (symbol.locator.name.trim().length === 0) {
      violations.push({ rule: "locator.named", detail: where });
    }
    if (!wellFormed(symbol.range)) {
      violations.push({ rule: "range.well-formed", detail: where });
    }
    if (!wellFormed(symbol.locator.selectionRange)) {
      violations.push({ rule: "selection-range.well-formed", detail: where });
    }
    if (!contains(symbol.range, symbol.locator.selectionRange)) {
      violations.push({ rule: "selection-range.within-declaration", detail: where });
    }
  }

  // A result over the ceiling is the failure the flag cannot excuse: the consumer asked for at most
  // this many, and more than that is not a truncated answer but an unbounded one.
  if (subject.symbols.length > subject.limit) {
    violations.push({
      rule: "search.within-requested-limit",
      detail: `${subject.symbols.length} hits for a limit of ${subject.limit}`,
    });
  }

  return violations;
}

export function checkDiagnostics(subject: DiagnosticsResponseSubject): Violation[] {
  const violations: Violation[] = [];
  const seenUris = new Set<string>();

  for (const entry of subject.documents) {
    const uri = entry.document.uri;
    if (seenUris.has(uri)) {
      violations.push({ rule: "diagnostics.one-entry-per-document", detail: uri });
    }
    seenUris.add(uri);

    if (!withinAnyRoot(uri, subject.workspace)) {
      violations.push({ rule: "diagnostics.within-a-root", detail: uri });
    }
    if (entry.document.workspaceId !== subject.workspace.workspaceId) {
      violations.push({ rule: "diagnostics.belongs-to-workspace", detail: uri });
    }
    if (entry.diagnostics.length > subject.perDocumentLimit && !subject.truncated) {
      // Exceeding the ceiling without saying so presents a capped list as the whole story.
      violations.push({ rule: "diagnostics.truncation-declared", detail: uri });
    }

    for (const diagnostic of entry.diagnostics) {
      if (!wellFormed(diagnostic.range)) {
        violations.push({ rule: "diagnostics.range-well-formed", detail: uri });
      }
      if (diagnostic.message.trim().length === 0) {
        violations.push({ rule: "diagnostics.message-present", detail: uri });
      }

      const fixes = diagnostic.availableFixes;
      if (fixes !== undefined) {
        // An empty array claims the adapter looked and the IDE offered nothing; omitting the field
        // says it did not look. They are different answers, and only one of them is a fact.
        if (fixes.length === 0) {
          violations.push({ rule: "fixes.absent-not-empty", detail: uri });
        }
        const seenFixIds = new Set<string>();
        for (const fix of fixes) {
          if (seenFixIds.has(fix.fixId)) {
            // A repeated id makes two different offers indistinguishable, so preparing one of them
            // would apply whichever the adapter happened to find first.
            violations.push({ rule: "fixes.id-unique", detail: `${uri} ${fix.fixId}` });
          }
          seenFixIds.add(fix.fixId);
          if (fix.title.trim().length === 0) {
            violations.push({ rule: "fixes.title-present", detail: uri });
          }
        }
      }
    }
  }
  return violations;
}

/**
 * Checks that a workspace is self-consistent before anything is asked of it.
 *
 * A root that is not a URI, or a duplicate root id, makes every later response unverifiable: there
 * is no ground truth to check containment against.
 */
export function checkWorkspace(workspace: Workspace): Violation[] {
  const violations: Violation[] = [];
  const rootIds = new Set<string>();

  if (workspace.roots.length === 0) {
    violations.push({ rule: "workspace.has-a-root", detail: workspace.workspaceId });
  }
  for (const root of workspace.roots) {
    if (rootIds.has(root.rootId)) {
      violations.push({ rule: "workspace.unique-root-ids", detail: root.rootId });
    }
    rootIds.add(root.rootId);
    if (!root.uri.includes("://")) {
      violations.push({ rule: "workspace.roots-are-uris", detail: root.uri });
    }
    if (!isUriWithinWorkspaceRoot(root.uri, root.uri)) {
      // A root must contain itself; one that does not cannot authorize any document under it.
      violations.push({ rule: "workspace.root-contains-itself", detail: root.uri });
    }
  }
  return violations;
}

export interface EditPlanSubject {
  readonly workspace: Workspace;
  readonly adapterId: string;
  readonly sessionId: string;
  readonly plan: EditPlan;
}

export interface ModificationSubject {
  readonly workspace: Workspace;
  readonly plan: EditPlan;
  readonly modifiedDocuments: readonly ModifiedDocument[];
}

/**
 * Checks a `refactor/prepareRename` plan.
 *
 * A plan is a promise about what applying it will change. These are the rules that make it a usable
 * promise: bound to the session that can consume it, naming documents inside the workspace, and
 * carrying a precondition for what it intends to rewrite.
 */
export function checkEditPlan(subject: EditPlanSubject): Violation[] {
  const violations: Violation[] = [];
  const { plan } = subject;

  if (plan.adapterId !== subject.adapterId) {
    violations.push({ rule: "plan.bound-to-adapter", detail: plan.planId });
  }
  if (plan.sessionId !== subject.sessionId) {
    violations.push({ rule: "plan.bound-to-session", detail: plan.planId });
  }
  if (plan.workspaceId !== subject.workspace.workspaceId) {
    violations.push({ rule: "plan.bound-to-workspace", detail: plan.planId });
  }
  if (Number.isNaN(Date.parse(plan.expiresAt))) {
    violations.push({ rule: "plan.expiry-is-a-timestamp", detail: plan.expiresAt });
  }
  if (plan.changes.length === 0) {
    // A plan that changes nothing is not a plan; it is a refusal wearing a success.
    violations.push({ rule: "plan.changes-something", detail: plan.planId });
  }

  const changed = new Set<string>();
  for (const change of plan.changes) {
    if (changed.has(change.uri)) {
      violations.push({ rule: "plan.one-entry-per-document", detail: change.uri });
    }
    changed.add(change.uri);
    if (!withinAnyRoot(change.uri, subject.workspace)) {
      violations.push({ rule: "plan.changes-within-a-root", detail: change.uri });
    }
    if (change.editCount < 1) {
      violations.push({ rule: "plan.change-counts-an-edit", detail: change.uri });
    }
  }

  for (const precondition of plan.preconditions) {
    if (precondition.workspaceEpoch !== subject.workspace.workspaceEpoch) {
      violations.push({ rule: "plan.precondition-current-epoch", detail: precondition.uri });
    }
    if (!changed.has(precondition.uri)) {
      // Guarding a document the plan does not touch protects nothing, and leaves whatever it does
      // touch unguarded.
      violations.push({ rule: "plan.precondition-covers-a-change", detail: precondition.uri });
    }
  }
  return violations;
}

/** Checks a `workspace/applyPlan` result against the plan it consumed. */
export function checkModification(subject: ModificationSubject): Violation[] {
  const violations: Violation[] = [];
  const planned = new Set(subject.plan.changes.map((change) => change.uri));

  for (const modified of subject.modifiedDocuments) {
    const uri = modified.document.uri;
    if (!planned.has(uri)) {
      // Changing a document the plan never named is the failure two phases exist to prevent: the
      // consumer approved something else.
      violations.push({ rule: "modification.was-planned", detail: uri });
    }
    if (!withinAnyRoot(uri, subject.workspace)) {
      violations.push({ rule: "modification.within-a-root", detail: uri });
    }
    if (modified.beforeHash === modified.afterHash) {
      violations.push({ rule: "modification.actually-changed", detail: uri });
    }
  }
  return violations;
}
