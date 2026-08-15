import type { AdapterId, SessionId, WorkspaceId } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  VscodeSymbolHandleRegistry,
  mapVscodeDocumentSymbols,
  mapVscodeWorkspaceSymbols,
  type VscodeDocumentSymbolLike,
} from "../src/symbol-mapper.js";

const documentUri = "file:///workspace/project/src/service.ts";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function documentSymbol(
  name: string,
  kind: number,
  declaration = range(0, 0, 0, 10),
  selection = range(0, 0, 0, name.length),
  children: VscodeDocumentSymbolLike[] = [],
): VscodeDocumentSymbolLike {
  return { name, kind, range: declaration, selectionRange: selection, children };
}

function fakeUri(value: string) {
  return { toString: () => value };
}

function workspaceSymbol(name: string, uri: string, kind = 4, containerName = "") {
  return {
    name,
    kind,
    containerName,
    location: { uri: fakeUri(uri), range: range(2, 6, 2, 6 + name.length) },
  };
}

function searchContext() {
  return {
    adapterId: "adapter_symbols" as AdapterId,
    sessionId: "session_symbols" as SessionId,
    workspaceId: "ws_symbols" as WorkspaceId,
    workspaceEpoch: 3,
  };
}

function materializeContext(uri = documentUri) {
  return {
    adapterId: "adapter_symbols" as AdapterId,
    sessionId: "session_symbols" as SessionId,
    workspaceId: "ws_symbols" as WorkspaceId,
    documentUri: uri,
    editorVersion: 7,
    workspaceEpoch: 3,
  };
}

describe("VS Code symbol mapping", () => {
  it("maps hierarchical document symbols with semantic locators", () => {
    const child = documentSymbol("run", 5, range(1, 2, 3, 3), range(1, 2, 1, 5));
    const parent = documentSymbol("Service", 4, range(0, 0, 4, 1), range(0, 6, 0, 13), [child]);

    const drafts = mapVscodeDocumentSymbols([parent], documentUri);

    expect(drafts).toMatchObject([
      {
        locator: {
          documentUri,
          name: "Service",
          kind: "class",
          positionEncoding: "utf-16",
        },
        children: [
          {
            locator: {
              documentUri,
              name: "run",
              kind: "method",
              containerName: "Service",
              positionEncoding: "utf-16",
            },
          },
        ],
      },
    ]);
    expect(drafts?.[0]?.locator).not.toHaveProperty("qualifiedName");
    expect(drafts?.[0]?.locator.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("maps all VS Code symbol kinds exactly and distinguishes overload fingerprints", () => {
    const symbols = Array.from({ length: 26 }, (_, kind) =>
      documentSymbol(`symbol${kind}`, kind, range(kind, 0, kind, 20), range(kind, 1, kind, 8)),
    );
    const mapped = mapVscodeDocumentSymbols(symbols, documentUri);
    expect(mapped?.map(({ locator }) => locator.kind)).toEqual([
      "file",
      "module",
      "namespace",
      "package",
      "class",
      "method",
      "property",
      "field",
      "constructor",
      "enum",
      "interface",
      "function",
      "variable",
      "constant",
      "string",
      "number",
      "boolean",
      "array",
      "object",
      "key",
      "null",
      "enumMember",
      "struct",
      "event",
      "operator",
      "typeParameter",
    ]);

    const overloads = mapVscodeDocumentSymbols(
      [
        documentSymbol("run", 5, range(30, 0, 30, 10), range(30, 1, 30, 4)),
        documentSymbol("run", 5, range(31, 0, 31, 10), range(31, 1, 31, 4)),
      ],
      documentUri,
    );
    expect(overloads?.[0]?.locator.fingerprint).not.toBe(overloads?.[1]?.locator.fingerprint);
  });

  it("accepts flat SymbolInformation but rejects foreign and malformed results", () => {
    const flat = {
      name: "value",
      kind: 12,
      containerName: "module",
      location: { uri: { toString: () => documentUri }, range: range(2, 6, 2, 11) },
    };
    expect(mapVscodeDocumentSymbols([flat], documentUri)).toMatchObject([
      {
        locator: { name: "value", kind: "variable", containerName: "module" },
        children: [],
      },
    ]);

    expect(() =>
      mapVscodeDocumentSymbols(
        [
          {
            ...flat,
            location: {
              uri: { toString: () => "file:///workspace/other.ts" },
              range: flat.location.range,
            },
          },
        ],
        documentUri,
      ),
    ).toThrow("foreign URI");
    expect(() =>
      mapVscodeDocumentSymbols([flat, documentSymbol("mixed", 12)], documentUri),
    ).toThrow("mixed or malformed");
    expect(mapVscodeDocumentSymbols(undefined, documentUri)).toBeUndefined();
    expect(mapVscodeDocumentSymbols([], documentUri)).toEqual([]);
  });

  it("rejects cycles, unsupported kinds, and selection ranges outside declarations", () => {
    const cyclic = documentSymbol("cycle", 4);
    (cyclic.children as VscodeDocumentSymbolLike[]).push(cyclic);
    expect(() => mapVscodeDocumentSymbols([cyclic], documentUri)).toThrow("structural bounds");
    expect(() => mapVscodeDocumentSymbols([documentSymbol("future", 26)], documentUri)).toThrow(
      "unsupported",
    );
    expect(() =>
      mapVscodeDocumentSymbols(
        [documentSymbol("outside", 12, range(1, 0, 1, 3), range(1, 0, 1, 7))],
        documentUri,
      ),
    ).toThrow("outside");
    expect(() =>
      mapVscodeDocumentSymbols(
        Array.from({ length: 5_001 }, (_, index) => documentSymbol(`symbol${index}`, 12)),
        documentUri,
      ),
    ).toThrow("structural bounds");
  });
});

describe("VS Code symbol handle registry", () => {
  it("binds handles to the physical session and current workspace epoch", () => {
    const drafts = mapVscodeDocumentSymbols(
      [documentSymbol("Service", 4, range(0, 0, 2, 1), range(0, 6, 0, 13))],
      documentUri,
    );
    const registry = new VscodeSymbolHandleRegistry();
    const symbols = registry.materialize(drafts ?? [], materializeContext());

    expect(symbols).toMatchObject([
      {
        handle: {
          adapterId: "adapter_symbols",
          sessionId: "session_symbols",
          validUntilEpoch: 3,
        },
        locator: { documentUri },
      },
    ]);
    expect(symbols[0]?.handle.id).toMatch(/^sym_[A-Za-z0-9_-]{24}$/u);
  });

  it("enforces capacity atomically and releases it on document invalidation", () => {
    const registry = new VscodeSymbolHandleRegistry(1);
    const first = mapVscodeDocumentSymbols([documentSymbol("first", 12)], documentUri) ?? [];
    const secondUri = "file:///workspace/project/src/second.ts";
    const second = mapVscodeDocumentSymbols([documentSymbol("second", 12)], secondUri) ?? [];
    registry.materialize(first, materializeContext());

    expect(() => registry.materialize(second, materializeContext(secondUri))).toThrow(
      "capacity exceeded",
    );
    registry.invalidateDocument("ws_symbols" as WorkspaceId, documentUri);
    expect(() => registry.materialize(second, materializeContext(secondUri))).not.toThrow();
    registry.invalidateAll();
    expect(() => registry.materialize(first, materializeContext())).not.toThrow();
  });

  it("never lets a search evict the handles a document already handed out", () => {
    const registry = new VscodeSymbolHandleRegistry();
    const documentDrafts =
      mapVscodeDocumentSymbols([documentSymbol("Service", 4)], documentUri) ?? [];
    const searchDrafts =
      mapVscodeWorkspaceSymbols([workspaceSymbol("Service", documentUri)], {
        isWithinWorkspace: () => true,
        limit: 10,
      })?.drafts ?? [];

    registry.materialize(documentDrafts, materializeContext());
    expect(registry.size).toBe(1);

    // A search over the very same document adds its own handle rather than replacing the
    // document's handle set, which would silently revoke handles already sent to a consumer.
    registry.materializeTransient(searchDrafts, searchContext());
    expect(registry.size).toBe(2);

    // Changing that document still revokes both namespaces at once.
    registry.invalidateDocument("ws_symbols" as WorkspaceId, documentUri);
    expect(registry.size).toBe(0);
  });

  it("evicts the oldest search generation instead of failing a full registry", () => {
    const registry = new VscodeSymbolHandleRegistry(1);
    const searchDrafts =
      mapVscodeWorkspaceSymbols([workspaceSymbol("Service", documentUri)], {
        isWithinWorkspace: () => true,
        limit: 10,
      })?.drafts ?? [];

    const first = registry.materializeTransient(searchDrafts, searchContext());
    const second = registry.materializeTransient(searchDrafts, searchContext());

    expect(first[0]?.handle.id).not.toBe(second[0]?.handle.id);
    expect(registry.size).toBe(1);
    // A document result still has priority over accumulated search history.
    const documentDrafts =
      mapVscodeDocumentSymbols([documentSymbol("Service", 4)], documentUri) ?? [];
    expect(() => registry.materialize(documentDrafts, materializeContext())).not.toThrow();
  });

  it("invalidates search handles for a document that changes", () => {
    const registry = new VscodeSymbolHandleRegistry(1);
    const searchDrafts =
      mapVscodeWorkspaceSymbols([workspaceSymbol("Service", documentUri)], {
        isWithinWorkspace: () => true,
        limit: 10,
      })?.drafts ?? [];
    registry.materializeTransient(searchDrafts, searchContext());
    registry.invalidateDocument("ws_symbols" as WorkspaceId, documentUri);

    const documentDrafts =
      mapVscodeDocumentSymbols([documentSymbol("Service", 4)], documentUri) ?? [];
    expect(() => registry.materialize(documentDrafts, materializeContext())).not.toThrow();
  });
});

describe("VS Code workspace symbol mapping", () => {
  it("maps flat hits, omits an empty container name, and never invents children", () => {
    const mapping = mapVscodeWorkspaceSymbols([workspaceSymbol("Service", documentUri)], {
      isWithinWorkspace: () => true,
      limit: 10,
    });

    expect(mapping?.incomplete).toBe(false);
    expect(mapping?.drafts).toMatchObject([
      {
        locator: {
          documentUri,
          name: "Service",
          kind: "class",
          positionEncoding: "utf-16",
        },
        children: [],
      },
    ]);
    expect(mapping?.drafts[0]?.locator).not.toHaveProperty("containerName");
    // SymbolInformation exposes one range only; it backs both the declaration and the selection.
    expect(mapping?.drafts[0]?.range).toEqual(mapping?.drafts[0]?.locator.selectionRange);
  });

  it("separates scope filtering from unrepresentable entries", () => {
    const outOfScope = mapVscodeWorkspaceSymbols([workspaceSymbol("Service", documentUri)], {
      isWithinWorkspace: () => false,
      limit: 10,
    });
    expect(outOfScope).toEqual({ drafts: [], incomplete: false });

    const rangeless = mapVscodeWorkspaceSymbols(
      [{ name: "Service", kind: 4, containerName: "", location: { uri: fakeUri(documentUri) } }],
      { isWithinWorkspace: () => true, limit: 10 },
    );
    expect(rangeless).toEqual({ drafts: [], incomplete: true });

    const unattributable = mapVscodeWorkspaceSymbols([{ name: "Service", kind: 4 }], {
      isWithinWorkspace: () => true,
      limit: 10,
    });
    expect(unattributable).toEqual({ drafts: [], incomplete: true });
  });

  it("distinguishes an absent provider from an empty result", () => {
    const options = { isWithinWorkspace: () => true, limit: 10 };
    expect(mapVscodeWorkspaceSymbols(undefined, options)).toBeUndefined();
    expect(mapVscodeWorkspaceSymbols(null, options)).toBeUndefined();
    expect(mapVscodeWorkspaceSymbols([], options)).toEqual({ drafts: [], incomplete: false });
    expect(() => mapVscodeWorkspaceSymbols("nope", options)).toThrow("non-array");
  });

  it("tolerates a missing container name but rejects an unsupported kind", () => {
    const withoutContainer = {
      name: "Service",
      kind: 4,
      location: { uri: fakeUri(documentUri), range: range(1, 0, 1, 7) },
    };
    expect(
      mapVscodeWorkspaceSymbols([withoutContainer], {
        isWithinWorkspace: () => true,
        limit: 10,
      })?.drafts,
    ).toHaveLength(1);

    const badKind = { ...withoutContainer, kind: 99 };
    expect(
      mapVscodeWorkspaceSymbols([badKind], { isWithinWorkspace: () => true, limit: 10 }),
    ).toEqual({ drafts: [], incomplete: true });
  });
});
