import { describe, expect, it } from "vitest";

import type {
  BridgeHandshakeRequest,
  CancelRequestNotification,
  Capability,
  DocumentReadRequest,
  WorkspaceApplyPlanRequest,
} from "../src/index.js";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("generated protocol types", () => {
  it("preserves request method discriminants across serialization", () => {
    const handshake: BridgeHandshakeRequest = {
      jsonrpc: "2.0",
      id: "handshake-typed",
      method: "bridge/handshake",
      params: {
        authentication: {
          method: "token",
          token: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        },
        role: "consumer",
        protocol: {
          minimum: "0.1.0",
          maximum: "0.1.0",
        },
        topology: {
          hostKind: "local",
          environmentKind: "local",
          uriSchemes: ["file"],
        },
        clientInfo: {
          name: "typed-fixture",
          version: "0.1.0",
        },
      },
    };

    const read: DocumentReadRequest = {
      jsonrpc: "2.0",
      id: "read-typed",
      method: "document/read",
      params: {
        workspaceId: "ws_fixture_1",
        uri: "vscode-remote://ssh-remote+example/workspace/src/service.ts",
      },
    };

    expect(roundTrip(handshake).method).toBe("bridge/handshake");
    expect(roundTrip(read).params.uri).toBe(read.params.uri);
  });

  it("exposes cancellation and two-phase apply as distinct generated contracts", () => {
    const cancel: CancelRequestNotification = {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: {
        id: "apply-typed",
      },
    };
    const apply: WorkspaceApplyPlanRequest = {
      jsonrpc: "2.0",
      id: "apply-typed",
      method: "workspace/applyPlan",
      params: {
        workspaceId: "ws_fixture_1",
        planId: "plan_fixture_1",
        includePostApplyDiagnostics: true,
      },
    };

    expect(roundTrip(cancel).params.id).toBe(apply.id);
    expect(roundTrip(apply).params.planId).toBe("plan_fixture_1");
  });

  it("keeps operation-dependent dimensions separate from unavailable capabilities", () => {
    const available: Capability = {
      support: "provider",
      guarantee: "semantic",
      preview: true,
    };
    const apply: Capability = {
      support: "native",
      atomicity: "text-only",
    };
    const unavailable: Capability = {
      support: "unavailable",
      reason: "No semantic provider is installed",
    };

    expect(available.support).toBe("provider");
    expect(apply.atomicity).toBe("text-only");
    expect(unavailable.support).toBe("unavailable");
  });
});
