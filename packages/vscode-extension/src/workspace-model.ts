import type {
  AdapterId,
  RootId,
  Workspace,
  WorkspaceId,
  WorkspaceRoot,
} from "@ide-bridge/protocol";

import { createOpaqueIdentifier } from "./identifiers.js";

export interface VscodeUriLike {
  toString(): string;
}

export interface VscodeWorkspaceFolderLike {
  name: string;
  uri: VscodeUriLike;
}

export interface WorkspaceSnapshotOptions {
  name?: string;
  trusted: boolean;
}

type RootIdFactory = () => RootId;

export class VscodeWorkspaceModel {
  readonly adapterId: AdapterId;
  readonly workspaceId: WorkspaceId;
  #workspaceEpoch = 0;
  #initialized = false;
  #activeUris: string[] = [];
  #rootIds = new Map<string, RootId>();
  readonly #createRootId: RootIdFactory;

  constructor(
    adapterId: AdapterId,
    workspaceId: WorkspaceId = createOpaqueIdentifier("ws_"),
    createRootId: RootIdFactory = () => createOpaqueIdentifier("root_"),
  ) {
    this.adapterId = adapterId;
    this.workspaceId = workspaceId;
    this.#createRootId = createRootId;
  }

  get workspaceEpoch(): number {
    return this.#workspaceEpoch;
  }

  snapshot(
    folders: readonly VscodeWorkspaceFolderLike[] | undefined,
    options: WorkspaceSnapshotOptions,
  ): [] | [Workspace] {
    if (folders === undefined || folders.length === 0) {
      this.#synchronizeRoots([]);
      return [];
    }

    this.#synchronizeRoots(folders.map((folder) => folder.uri.toString()));
    const roots = folders.map((folder) => this.#mapRoot(folder));

    return [
      {
        workspaceId: this.workspaceId,
        adapterId: this.adapterId,
        name: nonEmptyName(options.name, folders[0]?.name, "VS Code Workspace"),
        roots: roots as [WorkspaceRoot, ...WorkspaceRoot[]],
        workspaceEpoch: this.#workspaceEpoch,
        trust: options.trusted ? "trusted" : "untrusted",
      },
    ];
  }

  invalidateSemanticState(): number {
    this.#workspaceEpoch += 1;
    return this.#workspaceEpoch;
  }

  rootFor(folder: VscodeWorkspaceFolderLike): WorkspaceRoot | undefined {
    const uri = folder.uri.toString();
    const rootId = this.#rootIds.get(uri);
    if (rootId === undefined) return undefined;
    return { rootId, name: nonEmptyName(folder.name, "Workspace Root"), uri };
  }

  #mapRoot(folder: VscodeWorkspaceFolderLike): WorkspaceRoot {
    const uri = folder.uri.toString();
    const rootId = this.#rootIds.get(uri) ?? this.#createRootId();
    this.#rootIds.set(uri, rootId);
    return { rootId, name: nonEmptyName(folder.name, "Workspace Root"), uri };
  }

  #synchronizeRoots(activeUris: readonly string[]): void {
    if (new Set(activeUris).size !== activeUris.length) {
      throw new Error("VS Code workspace roots must have unique URIs");
    }

    const previousUris = this.#activeUris;
    const changed =
      previousUris.length !== activeUris.length ||
      previousUris.some((uri, index) => uri !== activeUris[index]);

    for (const uri of previousUris) {
      if (!activeUris.includes(uri)) this.#rootIds.delete(uri);
    }

    if (this.#initialized && changed) this.#workspaceEpoch += 1;
    this.#activeUris = [...activeUris];
    this.#initialized = true;
  }
}

function nonEmptyName(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed.slice(0, 256);
  }
  throw new Error("A non-empty workspace name is required");
}
