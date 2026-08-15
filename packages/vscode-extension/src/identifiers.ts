import { randomBytes } from "node:crypto";

import type { AdapterId, RootId, WorkspaceId } from "@ide-bridge/protocol";

type IdentifierPrefix = "adapter_" | "root_" | "ws_";

export function createOpaqueIdentifier(prefix: "adapter_"): AdapterId;
export function createOpaqueIdentifier(prefix: "root_"): RootId;
export function createOpaqueIdentifier(prefix: "ws_"): WorkspaceId;
export function createOpaqueIdentifier(prefix: IdentifierPrefix): string {
  return `${prefix}${randomBytes(18).toString("base64url")}`;
}
