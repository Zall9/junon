import {
  isIDEBPApplicationResponse,
  type AdapterId,
  type RootId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceRoot,
} from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import type { VscodeDocumentUriLike, VscodeTextDocumentLike } from "../src/document-mapper.js";
import { hashInMemoryContent, mapTextDocument } from "../src/document-mapper.js";

function uri(serialized: string, path: string, authority = ""): VscodeDocumentUriLike {
  return {
    scheme: serialized.slice(0, serialized.indexOf(":")),
    authority,
    path,
    toString: () => serialized,
  };
}

const rootUri = uri(
  "vscode-remote://ssh-remote%2Bdev/work/project",
  "/work/project",
  "ssh-remote+dev",
);
const documentUri = uri(
  "vscode-remote://ssh-remote%2Bdev/work/project/src/space%20name.ts",
  "/work/project/src/space name.ts",
  "ssh-remote+dev",
);
const root: WorkspaceRoot = {
  rootId: "root_project" as RootId,
  name: "project",
  uri: rootUri.toString(),
};
const workspace: Workspace = {
  workspaceId: "ws_project" as WorkspaceId,
  adapterId: "adapter_vscode" as AdapterId,
  name: "project",
  roots: [root],
  workspaceEpoch: 7,
  trust: "trusted",
};

function document(text: string, version = 12): VscodeTextDocumentLike {
  return {
    uri: documentUri,
    version,
    languageId: "typescript",
    isDirty: true,
    getText: () => text,
  };
}

describe("VS Code document mapping", () => {
  it("hashes UTF-8 in-memory content and preserves the encoded remote URI", () => {
    const mapped = mapTextDocument(document("const face = '😀';\r\n"), {
      workspace,
      root,
      rootUri,
    });

    expect(mapped).toEqual({
      document: {
        workspaceId: "ws_project",
        rootId: "root_project",
        uri: "vscode-remote://ssh-remote%2Bdev/work/project/src/space%20name.ts",
        logicalPath: "src/space name.ts",
        revision: {
          editorVersion: 12,
          contentHash: hashInMemoryContent("const face = '😀';\r\n"),
          workspaceEpoch: 7,
        },
        positionEncoding: "utf-16",
        languageId: "typescript",
        isDirty: true,
      },
      text: "const face = '😀';\r\n",
    });
    expect(
      isIDEBPApplicationResponse("document/read", {
        jsonrpc: "2.0",
        id: "request_document_read",
        result: mapped,
      }),
    ).toBe(true);
  });

  it("changes the revision hash when an unsaved buffer changes", () => {
    const before = mapTextDocument(document("before", 2), { workspace, root, rootUri });
    const after = mapTextDocument(document("after", 3), { workspace, root, rootUri });

    expect(after.document.revision.editorVersion).toBe(3);
    expect(after.document.revision.contentHash).not.toBe(before.document.revision.contentHash);
  });

  it("rejects a document outside the selected workspace root", () => {
    const outside = {
      ...document("secret"),
      uri: uri("file:///outside/secret.ts", "/outside/secret.ts"),
    };
    expect(() => mapTextDocument(outside, { workspace, root, rootUri })).toThrow(
      "outside the selected workspace root",
    );
  });

  it("rejects a root that is not owned by the workspace", () => {
    const foreignRoot = { ...root, rootId: "root_foreign" as RootId };
    expect(() =>
      mapTextDocument(document("text"), { workspace, root: foreignRoot, rootUri }),
    ).toThrow("does not belong to the workspace");
  });

  it("rejects an invalid editor version", () => {
    expect(() => mapTextDocument(document("text", -1), { workspace, root, rootUri })).toThrow(
      "non-negative safe integer",
    );
  });
});
