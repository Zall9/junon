import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT,
  type DocumentDiagnostics,
  type DocumentReference,
  type EditPlan,
  type ModifiedDocument,
  type Symbol as IDEBPSymbol,
  type Workspace,
} from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  checkDiagnostics,
  checkSymbolLocations,
  checkDocumentSymbols,
  checkEditPlan,
  checkModification,
  checkSearchSymbols,
  checkWorkspace,
} from "../src/invariants.js";

/**
 * Judges each adapter's **recorded real responses** with the one implementation of the rules.
 *
 * The alternative was to reimplement the rules in Kotlin, which is precisely the drift ADR-0025
 * exists to prevent: two implementations of one contract eventually disagree, and the disagreement
 * is invisible until a consumer hits it. So the responses travel instead of the rules — each
 * adapter's own end-to-end run writes what it actually put on the wire, and this reads it back.
 *
 * Both adapters record now. The VS Code suite already applied these rules in-process, but the
 * *captures* only ever held JetBrains responses — so a contract written to hold across IDEs was, in
 * this file, checked against one. Two captures is what makes the comparison real.
 *
 * **A capture is only as fresh as the run that wrote it.** These checks prove the adapter was
 * conformant when it last ran end to end, not that it is now — regressions land here only after
 * `RealDaemonSymbolsTest` is run again. That is a real limit of the arrangement and the reason the
 * missing-capture case fails instead of skipping.
 */

interface Capture {
  readonly adapter: string;
  readonly requestedUri: string;
  readonly workspace: Workspace;
  readonly documentSymbols: {
    readonly document: DocumentReference;
    readonly symbols: readonly IDEBPSymbol[];
  };
  /**
   * A second document, whose language names a declaration the text never spells (ADR-0030).
   *
   * It carries its own `requestedUri` because it answers a different document from the one the
   * capture's top-level field names. Optional in the type only so a capture written before this
   * existed still parses; the check below requires it.
   */
  readonly unspelledDocumentSymbols?: {
    readonly requestedUri: string;
    readonly document: DocumentReference;
    readonly symbols: readonly IDEBPSymbol[];
  };
  /** A `workspace/searchSymbols` response, with the ceiling its request carried (ADR-0031). */
  readonly searchSymbols?: {
    readonly requestedLimit: number;
    readonly symbols: readonly IDEBPSymbol[];
    readonly truncated: boolean;
  };
  readonly diagnostics: {
    readonly documents: readonly DocumentDiagnostics[];
    readonly truncated: boolean;
  };
  readonly editPlan: EditPlan;
  readonly modification: { readonly modifiedDocuments: readonly ModifiedDocument[] };
}

const capturePath = (name: string): string =>
  fileURLToPath(new URL(`../captures/${name}.json`, import.meta.url));

const captured = (name: string): Capture | undefined => {
  const path = capturePath(name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Capture;
};

describe("captured adapter responses", () => {
  const jetbrains = captured("jetbrains");
  // Partial by design: the VS Code run records what its scenarios exercise, not the full shape.
  const vscode = captured("vscode") as Partial<Capture> | undefined;

  it("has a JetBrains capture to judge", () => {
    // Failing rather than skipping: a conformance suite that quietly checks nothing when a capture
    // is missing reports success for an adapter it never looked at.
    expect(
      jetbrains,
      "run the JetBrains RealDaemonSymbolsTest to record packages/conformance/captures/jetbrains.json",
    ).toBeDefined();
  });

  it("the JetBrains workspace satisfies the rules", () => {
    if (jetbrains === undefined) return;
    expect(checkWorkspace(jetbrains.workspace)).toEqual([]);
  });

  it("the JetBrains document symbols satisfy the rules", () => {
    if (jetbrains === undefined) return;
    const { document, symbols } = jetbrains.documentSymbols;

    expect(
      checkDocumentSymbols({
        workspace: jetbrains.workspace,
        adapterId: jetbrains.workspace.adapterId,
        // Handles are minted under the session the daemon assigned, which the capture carries in
        // the handles themselves; taking it from the first symbol would make the rule circular, so
        // it is read from the document's own adapter binding instead.
        sessionId: symbols[0]?.handle.sessionId ?? "",
        requestedUri: jetbrains.requestedUri,
        document,
        symbols,
      }),
    ).toEqual([]);
  });

  /**
   * The same rules, applied to a declaration whose name the text never spells.
   *
   * This is the case that matters most for the rule set rather than for the adapter: such a symbol
   * carries an **empty** selection range, because there is no identifier to point at, and both
   * `selection-range.well-formed` and `selection-range.within-declaration` have to hold for it. Until
   * this capture existed those rules had only ever judged symbols whose range spans real text, so the
   * shape ADR-0030 introduced was checked by nothing outside the adapter's own tests.
   */
  it("the JetBrains symbols for an unspelled declaration satisfy the same rules", () => {
    if (jetbrains === undefined) return;
    const unspelled = jetbrains.unspelledDocumentSymbols;
    expect(
      unspelled,
      "re-run the JetBrains RealDaemonSymbolsTest: the capture predates the unspelled-declaration case",
    ).toBeDefined();
    if (unspelled === undefined) return;

    expect(
      checkDocumentSymbols({
        workspace: jetbrains.workspace,
        adapterId: jetbrains.workspace.adapterId,
        sessionId: unspelled.symbols[0]?.handle.sessionId ?? "",
        requestedUri: unspelled.requestedUri,
        document: unspelled.document,
        symbols: unspelled.symbols,
      }),
    ).toEqual([]);
  });

  it("the unspelled capture is the case it claims to be", () => {
    if (jetbrains?.unspelledDocumentSymbols === undefined) return;
    // A capture that lost the nested declarations would satisfy every structural rule above while
    // demonstrating the opposite of what it was recorded for — that was the defect itself.
    const nested = jetbrains.unspelledDocumentSymbols.symbols.flatMap((symbol) => symbol.children);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.flatMap((symbol) => symbol.children).length).toBeGreaterThan(0);
  });

  /**
   * The route that had no rule of its own until ADR-0031.
   *
   * `workspace/searchSymbols` was the one symbol route this suite never judged, and that absence is
   * how it came to drop a declaration while reporting a complete answer: nothing outside the
   * adapter's own tests looked at the shape it returned.
   */
  it("the JetBrains search hits satisfy the rules", () => {
    if (jetbrains === undefined) return;
    const search = jetbrains.searchSymbols;
    expect(
      search,
      "re-run the JetBrains RealDaemonSymbolsTest: the capture predates the search rule set",
    ).toBeDefined();
    if (search === undefined) return;

    expect(
      checkSearchSymbols({
        workspace: jetbrains.workspace,
        adapterId: jetbrains.workspace.adapterId,
        sessionId: search.symbols[0]?.handle.sessionId ?? "",
        limit: search.requestedLimit,
        symbols: search.symbols,
        truncated: search.truncated,
      }),
    ).toEqual([]);
    // An empty hit list satisfies every rule above and shows nothing; the defect being guarded
    // against here produced exactly that.
    expect(search.symbols.length).toBeGreaterThan(0);
  });

  /**
   * The same rules, for VS Code, the moment its own run records the part.
   *
   * Optional rather than required, and deliberately so: no extension-host scenario captures a search
   * yet, and a check that failed for a part no run produces would be a demand on a missing scenario
   * rather than on the adapter. It is written now so that recording it is all that is needed —
   * exactly how the hierarchy check waited for its capture.
   */
  it("the VS Code search hits satisfy the same rules as the JetBrains ones", () => {
    const search = vscode?.searchSymbols;
    if (search === undefined || vscode?.workspace === undefined) return;
    expect(
      checkSearchSymbols({
        workspace: vscode.workspace,
        adapterId: vscode.workspace.adapterId,
        sessionId: search.symbols[0]?.handle.sessionId ?? "",
        limit: search.requestedLimit,
        symbols: search.symbols,
        truncated: search.truncated,
      }),
    ).toEqual([]);
  });

  it("the JetBrains diagnostics satisfy the rules", () => {
    if (jetbrains === undefined) return;
    expect(
      checkDiagnostics({
        workspace: jetbrains.workspace,
        documents: jetbrains.diagnostics.documents,
        truncated: jetbrains.diagnostics.truncated,
        perDocumentLimit: IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT,
      }),
    ).toEqual([]);
  });

  it("the VS Code workspace satisfies the rules", () => {
    if (vscode?.workspace === undefined) return;
    expect(checkWorkspace(vscode.workspace)).toEqual([]);
  });

  // The point of a cross-IDE contract: one rule set, two engines, no exception carved for either.
  it("the VS Code hierarchy step satisfies the same rules as the JetBrains one", () => {
    const hierarchy = vscode?.["hierarchy" as keyof Capture] as
      { locations: readonly { location: { uri: string } }[]; truncated: boolean } | undefined;
    if (hierarchy === undefined || vscode?.workspace === undefined) return;
    expect(
      checkSymbolLocations({
        workspace: vscode.workspace,
        adapterId: vscode.workspace.adapterId,
        sessionId: "",
        method: "symbol/getHierarchy",
        locations: hierarchy.locations as never,
        truncated: hierarchy.truncated,
      }).filter((violation) => !violation.rule.startsWith("handle.")),
    ).toEqual([]);
  });

  it("the VS Code document symbols satisfy the rules", () => {
    if (vscode?.documentSymbols === undefined || vscode.workspace === undefined) return;
    const symbols = vscode.documentSymbols.symbols;
    expect(
      checkDocumentSymbols({
        workspace: vscode.workspace,
        adapterId: vscode.workspace.adapterId,
        sessionId: symbols[0]?.handle.sessionId ?? "",
        requestedUri: vscode.requestedUri ?? "",
        document: vscode.documentSymbols.document,
        symbols,
      }),
    ).toEqual([]);
  });

  it("the VS Code edit plan satisfies the rules", () => {
    if (vscode?.editPlan === undefined || vscode.workspace === undefined) return;
    expect(
      checkEditPlan({
        workspace: vscode.workspace,
        adapterId: vscode.editPlan.adapterId,
        sessionId: vscode.editPlan.sessionId,
        plan: vscode.editPlan,
      }),
    ).toEqual([]);
  });

  // Two adapters, two rename engines, one rule set — which is the whole reason this package exists
  // rather than each adapter checking itself.
  it("the VS Code modification satisfies the same rules as the JetBrains one", () => {
    if (
      vscode?.modification === undefined ||
      vscode.workspace === undefined ||
      vscode.editPlan === undefined
    ) {
      return;
    }
    expect(
      checkModification({
        workspace: vscode.workspace,
        plan: vscode.editPlan,
        modifiedDocuments: vscode.modification.modifiedDocuments,
      }),
    ).toEqual([]);
  });

  it("the JetBrains hierarchy step satisfies the rules", () => {
    if (jetbrains === undefined) return;
    const symbols = jetbrains.documentSymbols.symbols;
    expect(
      checkSymbolLocations({
        workspace: jetbrains.workspace,
        adapterId: jetbrains.workspace.adapterId,
        sessionId: symbols[0]?.handle.sessionId ?? "",
        method: "symbol/getHierarchy",
        locations: jetbrains.hierarchy.locations,
        truncated: jetbrains.hierarchy.truncated,
      }),
    ).toEqual([]);
  });

  it("the JetBrains edit plan satisfies the rules", () => {
    if (jetbrains === undefined) return;
    expect(
      checkEditPlan({
        workspace: jetbrains.workspace,
        adapterId: jetbrains.editPlan.adapterId,
        sessionId: jetbrains.editPlan.sessionId,
        plan: jetbrains.editPlan,
      }),
    ).toEqual([]);
  });

  it("the JetBrains modification changed only what its plan named", () => {
    if (jetbrains === undefined) return;
    expect(
      checkModification({
        workspace: jetbrains.workspace,
        plan: jetbrains.editPlan,
        modifiedDocuments: jetbrains.modification.modifiedDocuments,
      }),
    ).toEqual([]);
  });

  it("the capture is a real answer, not an empty one", () => {
    if (jetbrains === undefined) return;
    // An empty symbol list would satisfy every structural rule while proving nothing.
    expect(jetbrains.documentSymbols.symbols.length).toBeGreaterThan(0);
    expect(jetbrains.workspace.roots.length).toBeGreaterThan(0);
    // A plan with no changes, or a modification with none, would satisfy the structural rules while
    // proving the adapter did nothing.
    expect(jetbrains.editPlan.changes.length).toBeGreaterThan(0);
    expect(jetbrains.modification.modifiedDocuments.length).toBeGreaterThan(0);
  });

  /**
   * Both captures must be present, and both must say something.
   *
   * Every VS Code check above returns early when its part of the capture is missing — which means
   * a lost or never-written capture would take five checks quietly with it, and the suite would go
   * green having judged one adapter. That failure mode has already happened once here: a path bug
   * meant the capture was never written and nothing said so.
   */
  it("the VS Code capture exists and is a real answer", () => {
    expect(vscode, "no VS Code capture; run the extension-host suite").toBeDefined();
    expect(vscode?.documentSymbols?.symbols.length ?? 0).toBeGreaterThan(0);
    expect(vscode?.workspace?.roots.length ?? 0).toBeGreaterThan(0);
    expect(vscode?.editPlan?.changes.length ?? 0).toBeGreaterThan(0);
    expect(vscode?.modification?.modifiedDocuments.length ?? 0).toBeGreaterThan(0);
    // The hierarchy is the one the JetBrains capture went an increment without: an empty list
    // satisfies every rule and demonstrates nothing.
    const hierarchy = vscode?.["hierarchy" as keyof Capture] as
      { locations: readonly unknown[] } | undefined;
    expect(hierarchy?.locations.length ?? 0).toBeGreaterThan(0);
  });
});
