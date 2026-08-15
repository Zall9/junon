import { describe, expect, it } from "vitest";

import { checkSymbolLocations, type SymbolLocationsSubject } from "../src/invariants.js";

const workspace = {
  workspaceId: "ws_1",
  adapterId: "adapter_1",
  name: "fixture",
  roots: [{ rootId: "root_1", name: "fixture", uri: "file:///workspace/fixture/" }],
  workspaceEpoch: 3,
  trust: "trusted",
} as unknown as SymbolLocationsSubject["workspace"];

const location = (uri: string) => ({
  location: {
    uri,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    positionEncoding: "utf-16",
  },
});

const subject = (overrides: Partial<SymbolLocationsSubject> = {}): SymbolLocationsSubject =>
  ({
    workspace,
    adapterId: "adapter_1",
    sessionId: "session_1",
    method: "symbol/getHierarchy",
    locations: [location("file:///workspace/fixture/a.ts")],
    truncated: false,
    ...overrides,
  }) as SymbolLocationsSubject;

describe("symbol location conformance", () => {
  it("accepts a well-formed answer inside a root", () => {
    expect(checkSymbolLocations(subject())).toEqual([]);
  });

  it("rejects a location outside every registered root", () => {
    const violations = checkSymbolLocations(
      subject({
        locations: [location("file:///elsewhere/secret.ts")],
      } as Partial<SymbolLocationsSubject>),
    );

    expect(violations.map((v) => v.rule)).toContain("location.within-a-root");
  });

  it("rejects a range that runs backwards", () => {
    const backwards = {
      location: {
        uri: "file:///workspace/fixture/a.ts",
        range: { start: { line: 4, character: 0 }, end: { line: 2, character: 0 } },
        positionEncoding: "utf-16",
      },
    };

    const violations = checkSymbolLocations(
      subject({ locations: [backwards] } as unknown as Partial<SymbolLocationsSubject>),
    );

    expect(violations.map((v) => v.rule)).toContain("location.range-well-formed");
  });

  // The one combination that cannot be true: a cap applied to a list that was never filled.
  it("rejects truncation claimed over an empty result", () => {
    const violations = checkSymbolLocations(subject({ locations: [], truncated: true }));

    expect(violations.map((v) => v.rule)).toContain("truncation.implies-results");
  });

  it("accepts an empty result that claims nothing", () => {
    expect(checkSymbolLocations(subject({ locations: [], truncated: false }))).toEqual([]);
  });
});
