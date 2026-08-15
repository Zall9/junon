import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SymbolKind, SymbolLocator } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import type { SymbolDraft } from "../src/symbol-mapper.js";
import { findSymbolAtPosition, relocateSymbol } from "../src/symbol-relocation.js";
import { repositoryRoot } from "./support/repository-root.js";

const documentUri = "file:///workspace/project/src/service.ts";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function locator(
  name: string,
  kind: SymbolKind,
  selectionRange = range(4, 6, 4, 6 + name.length),
  containerName?: string,
  uri = documentUri,
): SymbolLocator {
  return {
    documentUri: uri,
    name,
    kind,
    ...(containerName === undefined ? {} : { containerName }),
    selectionRange,
    positionEncoding: "utf-16",
    fingerprint: `sha256:${"c".repeat(64)}`,
  };
}

function draft(
  value: SymbolLocator,
  declaration = value.selectionRange,
  children: SymbolDraft[] = [],
): SymbolDraft {
  return { locator: value, range: declaration, children };
}

interface RelocationVector {
  why: string;
  target: { name: string; kind: SymbolKind; containerName?: string; selectionRange: number[] };
  current: {
    name: string;
    kind: SymbolKind;
    containerName?: string;
    selectionRange: number[];
    range?: number[];
    documentUri?: string;
    children?: RelocationVector["current"];
  }[];
  expect: "resolved" | "not-found" | "ambiguous";
  resolvedSelectionStartLine?: number;
  candidateCount?: number;
}

const vectorsPath = resolve(
  repositoryRoot(),
  "packages/protocol/fixtures/vectors/symbol-relocation-vectors.json",
);
const vectorFile = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  documentUri: string;
  vectors: RelocationVector[];
};

function toRange(values: number[]) {
  return range(values[0]!, values[1]!, values[2]!, values[3]!);
}

function toDraft(entry: RelocationVector["current"][number]): SymbolDraft {
  return draft(
    locator(
      entry.name,
      entry.kind,
      toRange(entry.selectionRange),
      entry.containerName,
      entry.documentUri ?? vectorFile.documentUri,
    ),
    entry.range === undefined ? toRange(entry.selectionRange) : toRange(entry.range),
    (entry.children ?? []).map(toDraft),
  );
}

/**
 * Driven by the shared vector file, not by cases restated here. Relocation exists in TypeScript and
 * in Kotlin; the same protocol must not answer differently depending on the IDE (ADR-0025).
 */
describe("controlled symbol relocation", () => {
  it.each(vectorFile.vectors)("$why", (vector) => {
    const target = locator(
      vector.target.name,
      vector.target.kind,
      toRange(vector.target.selectionRange),
      vector.target.containerName,
      vectorFile.documentUri,
    );

    const outcome = relocateSymbol(target, vector.current.map(toDraft));

    if (vector.expect === "resolved") {
      expect(outcome.kind).toBe("resolved");
      if (outcome.kind !== "resolved") return;
      expect(outcome.draft.locator.selectionRange.start.line).toBe(
        vector.resolvedSelectionStartLine,
      );
      return;
    }
    if (vector.expect === "ambiguous") {
      expect(outcome.kind).toBe("ambiguous");
      if (outcome.kind !== "ambiguous") return;
      expect(outcome.candidates).toHaveLength(vector.candidateCount ?? 0);
      return;
    }
    expect(outcome).toEqual({ kind: "not-found" });
  });

  it("exercises every relocation outcome", () => {
    const outcomes = new Set(vectorFile.vectors.map((vector) => vector.expect));
    expect([...outcomes].sort()).toEqual(["ambiguous", "not-found", "resolved"]);
  });
});

describe("symbol lookup at a position", () => {
  it("returns the innermost containing symbol", () => {
    const method = draft(locator("update", "method", range(11, 2, 11, 8)), range(11, 2, 13, 3));
    const klass = draft(locator("StreamService", "class", range(9, 6, 9, 19)), range(9, 0, 20, 1), [
      method,
    ]);

    expect(findSymbolAtPosition([klass], { line: 12, character: 4 })?.locator.name).toBe("update");
    expect(findSymbolAtPosition([klass], { line: 10, character: 0 })?.locator.name).toBe(
      "StreamService",
    );
    expect(findSymbolAtPosition([klass], { line: 30, character: 0 })).toBeUndefined();
  });

  it("treats range boundaries as contained", () => {
    const klass = draft(locator("Service", "class", range(2, 6, 2, 13)), range(2, 0, 4, 1));
    expect(findSymbolAtPosition([klass], { line: 2, character: 0 })?.locator.name).toBe("Service");
    expect(findSymbolAtPosition([klass], { line: 4, character: 1 })?.locator.name).toBe("Service");
    expect(findSymbolAtPosition([klass], { line: 4, character: 2 })).toBeUndefined();
  });
});
