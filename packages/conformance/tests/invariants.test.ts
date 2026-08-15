import type { Symbol as IDEBPSymbol, Workspace } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  checkDiagnostics,
  checkDocumentSymbols,
  checkWorkspace,
  type SymbolResponseSubject,
} from "../src/invariants.js";

/**
 * Every rule is checked in both directions: that a correct response passes, and that the specific
 * defect it targets is caught. A rule only proven on good input would pass no matter what it did.
 */

const workspace: Workspace = {
  workspaceId: "ws_1",
  adapterId: "adapter_1",
  name: "demo",
  roots: [{ rootId: "root_1", name: "demo", uri: "file:///projects/demo" }],
  workspaceEpoch: 3,
  trust: "trusted",
};

const uri = "file:///projects/demo/src/Service.java";

const symbol = (over: Partial<IDEBPSymbol> = {}): IDEBPSymbol => ({
  handle: { adapterId: "adapter_1", sessionId: "session_1", id: "sym_1", validUntilEpoch: 3 },
  locator: {
    documentUri: uri,
    name: "Service",
    kind: "class",
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
    positionEncoding: "utf-16",
    fingerprint: `sha256:${"a".repeat(64)}`,
  },
  range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
  children: [],
  ...over,
});

const subject = (over: Partial<SymbolResponseSubject> = {}): SymbolResponseSubject => ({
  workspace,
  adapterId: "adapter_1",
  sessionId: "session_1",
  requestedUri: uri,
  document: {
    workspaceId: "ws_1",
    rootId: "root_1",
    uri,
    logicalPath: "src/Service.java",
    revision: { editorVersion: 1, contentHash: `sha256:${"b".repeat(64)}`, workspaceEpoch: 3 },
    positionEncoding: "utf-16",
    isDirty: false,
  },
  symbols: [symbol()],
  ...over,
});

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);

describe("document symbol invariants", () => {
  it("accepts a well-formed response", () => {
    expect(checkDocumentSymbols(subject())).toEqual([]);
  });

  it("catches a handle bound to another session", () => {
    const foreign = symbol({
      handle: {
        adapterId: "adapter_1",
        sessionId: "session_other",
        id: "sym_1",
        validUntilEpoch: 3,
      },
    });

    // This is what the daemon closes a session over, so it must never leave an adapter.
    expect(rules(checkDocumentSymbols(subject({ symbols: [foreign] })))).toContain(
      "handle.bound-to-session",
    );
  });

  it("catches a stale epoch and a foreign adapter", () => {
    const stale = symbol({
      handle: { adapterId: "adapter_x", sessionId: "session_1", id: "sym_1", validUntilEpoch: 2 },
    });

    expect(rules(checkDocumentSymbols(subject({ symbols: [stale] })))).toEqual(
      expect.arrayContaining(["handle.bound-to-adapter", "handle.bound-to-epoch"]),
    );
  });

  it("catches a duplicate handle across the tree", () => {
    const parent = symbol({ children: [symbol()] });

    // Both carry sym_1; a consumer resolving one would silently address the other.
    expect(rules(checkDocumentSymbols(subject({ symbols: [parent] })))).toContain(
      "handle.unique-in-response",
    );
  });

  it("catches an identifier range outside its declaration", () => {
    const wrong = symbol({
      locator: {
        ...symbol().locator,
        selectionRange: { start: { line: 9, character: 0 }, end: { line: 9, character: 7 } },
      },
    });

    // A rename replaces the selection range; outside the declaration it rewrites other code.
    expect(rules(checkDocumentSymbols(subject({ symbols: [wrong] })))).toContain(
      "selection-range.within-declaration",
    );
  });

  it("catches a range that runs backwards", () => {
    const backwards = symbol({
      range: { start: { line: 4, character: 0 }, end: { line: 0, character: 0 } },
    });

    expect(rules(checkDocumentSymbols(subject({ symbols: [backwards] })))).toContain(
      "range.well-formed",
    );
  });

  it("catches a symbol pointing outside every root", () => {
    const foreign = symbol({
      locator: { ...symbol().locator, documentUri: "file:///elsewhere/Other.java" },
    });

    expect(rules(checkDocumentSymbols(subject({ symbols: [foreign] })))).toEqual(
      expect.arrayContaining(["locator.same-document", "locator.within-a-root"]),
    );
  });

  it("checks nested symbols, not only the first level", () => {
    const nested = symbol({
      children: [
        symbol({
          handle: {
            adapterId: "adapter_1",
            sessionId: "session_1",
            id: "sym_2",
            validUntilEpoch: 9,
          },
        }),
      ],
    });

    // A defect one level down is as wrong as one at the top, and easier to miss.
    expect(rules(checkDocumentSymbols(subject({ symbols: [nested] })))).toContain(
      "handle.bound-to-epoch",
    );
  });

  it("catches an answer about a different document than the one requested", () => {
    const answered = subject();
    expect(
      rules(
        checkDocumentSymbols({
          ...answered,
          requestedUri: "file:///projects/demo/src/Other.java",
        }),
      ),
    ).toContain("document.matches-request");
  });
});

describe("diagnostic invariants", () => {
  const entry = (count: number) => ({
    document: subject().document,
    diagnostics: Array.from({ length: count }, () => ({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      positionEncoding: "utf-16" as const,
      severity: "error" as const,
      message: "cannot resolve symbol",
    })),
  });

  const withFixes = (fixes: Array<{ fixId: string; title: string }> | undefined) => ({
    document: subject().document,
    diagnostics: [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        positionEncoding: "utf-16" as const,
        severity: "error" as const,
        message: "cannot resolve symbol",
        ...(fixes === undefined ? {} : { availableFixes: fixes }),
      },
    ],
  });

  const check = (fixes: Array<{ fixId: string; title: string }> | undefined) =>
    rules(
      checkDiagnostics({
        workspace,
        documents: [withFixes(fixes) as unknown as ReturnType<typeof entry>],
        truncated: false,
        perDocumentLimit: 10,
      }),
    );

  it("accepts a diagnostic that offers fixes", () => {
    expect(check([{ fixId: "f1", title: "Change type to String" }])).toEqual([]);
  });

  it("accepts a diagnostic that offers none, by omitting the field", () => {
    expect(check(undefined)).toEqual([]);
  });

  // "The IDE offered nothing" and "nobody looked" are different answers; only one is a fact.
  it("catches an empty array standing in for an absent field", () => {
    expect(check([])).toContain("fixes.absent-not-empty");
  });

  // A repeated id makes two offers indistinguishable, so preparing one would apply whichever the
  // adapter happened to find first.
  it("catches two offers sharing an identifier", () => {
    expect(
      check([
        { fixId: "same", title: "Change type to String" },
        { fixId: "same", title: "Remove the initializer" },
      ]),
    ).toContain("fixes.id-unique");
  });

  it("accepts a bounded, well-formed snapshot", () => {
    expect(
      checkDiagnostics({
        workspace,
        documents: [entry(2)],
        truncated: false,
        perDocumentLimit: 10,
      }),
    ).toEqual([]);
  });

  it("catches a capped list presented as the whole story", () => {
    expect(
      rules(
        checkDiagnostics({
          workspace,
          documents: [entry(11)],
          truncated: false,
          perDocumentLimit: 10,
        }),
      ),
    ).toContain("diagnostics.truncation-declared");
  });

  it("accepts the same list once truncation is declared", () => {
    expect(
      checkDiagnostics({
        workspace,
        documents: [entry(11)],
        truncated: true,
        perDocumentLimit: 10,
      }),
    ).toEqual([]);
  });

  it("catches two entries for one document", () => {
    expect(
      rules(
        checkDiagnostics({
          workspace,
          documents: [entry(1), entry(1)],
          truncated: false,
          perDocumentLimit: 10,
        }),
      ),
    ).toContain("diagnostics.one-entry-per-document");
  });
});

describe("workspace invariants", () => {
  it("accepts a workspace with a real root", () => {
    expect(checkWorkspace(workspace)).toEqual([]);
  });

  it("catches a root that is a local path rather than a URI", () => {
    const broken = {
      ...workspace,
      roots: [{ rootId: "root_1", name: "demo", uri: "/projects/demo" }],
    };

    // Without a usable root there is no ground truth to check containment against.
    expect(rules(checkWorkspace(broken))).toEqual(
      expect.arrayContaining(["workspace.roots-are-uris", "workspace.root-contains-itself"]),
    );
  });

  it("catches duplicate root identifiers", () => {
    const duplicated = {
      ...workspace,
      roots: [
        { rootId: "root_1", name: "a", uri: "file:///projects/demo" },
        { rootId: "root_1", name: "b", uri: "file:///projects/other" },
      ],
    };

    expect(rules(checkWorkspace(duplicated))).toContain("workspace.unique-root-ids");
  });
});
