import type { IDEBPEndpointTopology } from "@ide-bridge/protocol";

import type { VscodeWorkspaceFolderLike } from "./workspace-model.js";

export interface VscodeTopologyEnvironment {
  appHost: string;
  remoteName?: string;
  workspaceFolders?: readonly (VscodeWorkspaceFolderLike & {
    uri: VscodeWorkspaceFolderLike["uri"] & { scheme: string };
  })[];
}

export function createVscodeTopology(
  environment: VscodeTopologyEnvironment,
): IDEBPEndpointTopology {
  const remoteName = environment.remoteName;
  const schemes = [
    ...new Set(
      environment.workspaceFolders
        ?.map((folder) => folder.uri.scheme)
        .filter((scheme) => /^[A-Za-z][A-Za-z0-9+.-]*$/u.test(scheme)) ?? [],
    ),
  ];
  if (schemes.length === 0) schemes.push(remoteName === undefined ? "file" : "vscode-remote");

  return {
    hostKind:
      environment.appHost !== "desktop"
        ? "web"
        : remoteName === undefined
          ? "local"
          : "remote-workspace",
    environmentKind: environmentKind(remoteName),
    uriSchemes: schemes as [string, ...string[]],
  };
}

function environmentKind(remoteName: string | undefined): IDEBPEndpointTopology["environmentKind"] {
  if (remoteName === undefined) return "local";
  if (remoteName === "wsl") return "wsl";
  if (remoteName === "dev-container" || remoteName.startsWith("attached-container")) {
    return "dev-container";
  }
  if (remoteName === "codespaces") return "codespace";
  if (remoteName === "ssh-remote" || remoteName.startsWith("ssh-remote+")) return "ssh";
  return "unknown";
}
