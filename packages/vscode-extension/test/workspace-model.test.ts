import {
  isIDEBPApplicationRequest,
  type AdapterId,
  type RootId,
  type WorkspaceId,
} from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

const adapterId = "adapter_vscode_test" as AdapterId;
const workspaceId = "ws_vscode_test" as WorkspaceId;

function folder(name: string, uri: string): VscodeWorkspaceFolderLike {
  return { name, uri: { toString: () => uri } };
}

function model(): VscodeWorkspaceModel {
  let nextRoot = 0;
  return new VscodeWorkspaceModel(
    adapterId,
    workspaceId,
    () => `root_test_${++nextRoot}` as RootId,
  );
}

describe("VscodeWorkspaceModel", () => {
  it("maps one VS Code window to one multi-root IDEBP workspace", () => {
    const state = model();
    const workspaces = state.snapshot(
      [
        folder("api", "vscode-remote://ssh-remote%2Bhost/work/api"),
        folder("web", "file:///work/web"),
      ],
      { name: "Moneta", trusted: true },
    );

    expect(workspaces).toEqual([
      {
        workspaceId,
        adapterId,
        name: "Moneta",
        roots: [
          {
            rootId: "root_test_1",
            name: "api",
            uri: "vscode-remote://ssh-remote%2Bhost/work/api",
          },
          { rootId: "root_test_2", name: "web", uri: "file:///work/web" },
        ],
        workspaceEpoch: 0,
        trust: "trusted",
      },
    ]);
  });

  it("keeps identifiers stable and increments the epoch only on structural changes", () => {
    const state = model();
    const api = folder("api", "file:///work/api");
    const web = folder("web", "file:///work/web");

    const first = state.snapshot([api], { trusted: false });
    const unchanged = state.snapshot([api], { trusted: true });
    const expanded = state.snapshot([api, web], { trusted: true });
    const contracted = state.snapshot([web], { trusted: true });

    expect(first[0]!.roots[0].rootId).toBe(unchanged[0]!.roots[0].rootId);
    expect(first[0]!.workspaceEpoch).toBe(0);
    expect(unchanged[0]!.workspaceEpoch).toBe(0);
    expect(unchanged[0]!.trust).toBe("trusted");
    expect(expanded[0]!.workspaceEpoch).toBe(1);
    expect(contracted[0]!.workspaceEpoch).toBe(2);
    expect(state.invalidateSemanticState()).toBe(3);
  });

  it("assigns a new root identity when a removed root is added again", () => {
    const state = model();
    const api = folder("api", "file:///work/api");
    const firstRootId = state.snapshot([api], { trusted: true })[0]!.roots[0].rootId;
    state.snapshot([], { trusted: true });
    const secondRootId = state.snapshot([api], { trusted: true })[0]!.roots[0].rootId;

    expect(secondRootId).not.toBe(firstRootId);
    expect(state.workspaceEpoch).toBe(2);
  });

  it("produces workspace DTOs accepted by the canonical registration schema", () => {
    const state = model();
    const workspaces = state.snapshot([folder("project", "file:///work/project")], {
      trusted: true,
    });

    expect(
      isIDEBPApplicationRequest("ide/register", {
        jsonrpc: "2.0",
        id: "request_vscode_registration",
        method: "ide/register",
        params: {
          adapterId,
          name: "IDE Bridge for VS Code",
          version: "0.0.0",
          ideKind: "vscode",
          ideVersion: "1.125.0",
          positionEncodings: ["utf-16"],
          capabilities: {},
          workspaces,
        },
      }),
    ).toBe(true);
  });

  it("does not expose an empty VS Code window as a protocol workspace", () => {
    const state = model();
    expect(state.snapshot(undefined, { trusted: true })).toEqual([]);
    expect(state.snapshot([], { trusted: false })).toEqual([]);
    expect(state.workspaceEpoch).toBe(0);
  });

  it("rejects duplicate root URIs", () => {
    const state = model();
    expect(() =>
      state.snapshot([folder("first", "file:///work"), folder("duplicate", "file:///work")], {
        trusted: true,
      }),
    ).toThrow("unique URIs");
  });
});
