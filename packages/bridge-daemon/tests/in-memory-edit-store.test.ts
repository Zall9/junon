import type { EditPlan, UndoToken } from "@ide-bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { EditStoreError, InMemoryEditStore } from "../src/plan/in-memory-edit-store.js";

const stores: InMemoryEditStore[] = [];
const context = {
  consumerSessionId: "session_consumer",
  adapterSessionId: "session_adapter",
  adapterId: "adapter_fixture",
  workspaceId: "ws_fixture",
  workspaceEpoch: 4,
  workspaceRootUris: ["file:///workspace/"],
} as const;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    planId: "plan_adapter_internal",
    adapterId: "adapter_fixture",
    sessionId: "session_adapter",
    workspaceId: "ws_fixture",
    expiresAt: "2026-08-01T12:10:00.000Z",
    operation: "rename",
    guarantee: "semantic",
    atomicity: "text-only",
    preconditions: [
      {
        type: "documentRevision",
        uri: "file:///workspace/a.ts",
        editorVersion: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        workspaceEpoch: 4,
      },
    ],
    changes: [{ kind: "textEdit", uri: "file:///workspace/a.ts", editCount: 2 }],
    warnings: [],
    ...overrides,
  };
}

function createStore(now = new Date("2026-08-01T12:00:00.000Z")): InMemoryEditStore {
  const store = new InMemoryEditStore({
    now: () => now,
    maximumPlanLifetimeMs: 60_000,
    createPlanId: () => "plan_public",
    createUndoTokenId: () => "undo_public",
  });
  stores.push(store);
  return store;
}

describe("in-memory edit store", () => {
  it("rewrites and bounds adapter plan authorization fields", () => {
    const store = createStore();
    const publicPlan = store.createPlan(plan(), context);

    expect(publicPlan).toMatchObject({
      planId: "plan_public",
      adapterId: "adapter_fixture",
      sessionId: "session_consumer",
      workspaceId: "ws_fixture",
      expiresAt: "2026-08-01T12:01:00.000Z",
    });
    const consumed = store.consumePlan("plan_public", "session_consumer", "ws_fixture", 4);
    expect(consumed.adapterPlan).toMatchObject({
      planId: "plan_adapter_internal",
      sessionId: "session_adapter",
    });
    expect(store.planCount).toBe(0);
  });

  it("rejects untrusted adapter ownership and incomplete preconditions", () => {
    const store = createStore();
    expect(() => store.createPlan(plan({ adapterId: "adapter_other" }), context)).toThrow(
      EditStoreError,
    );
    expect(() =>
      store.createPlan(
        plan({
          changes: [{ kind: "textEdit", uri: "file:///workspace/missing.ts", editCount: 1 }],
        }),
        context,
      ),
    ).toThrow(EditStoreError);
    expect(() =>
      store.createPlan(
        plan({
          preconditions: [
            {
              type: "documentRevision",
              uri: "file:///outside/a.ts",
              editorVersion: 1,
              contentHash: `sha256:${"a".repeat(64)}`,
              workspaceEpoch: 4,
            },
          ],
          changes: [{ kind: "textEdit", uri: "file:///outside/a.ts", editCount: 1 }],
        }),
        context,
      ),
    ).toThrow(EditStoreError);
  });

  // Every refusal here closes the adapter's session, and the close reason is the only channel that
  // reaches its author. Measured against a real IDE on 2026-08-14: preparing a rename disconnected
  // the JetBrains plugin, and the reason read `…rejected during prepare transformation:
  // PROVIDER_FAILED` — the name of the outcome, never the rule that refused. Six conditions could
  // have produced it and nothing distinguished them.
  it("names the rule that refused a plan, not merely the outcome", () => {
    const store = createStore();
    const refusals: [string, EditPlan][] = [
      ["plan names another adapter", plan({ adapterId: "adapter_other" })],
      ["plan names another session", plan({ sessionId: "session_other" })],
      ["plan names another workspace", plan({ workspaceId: "ws_other" })],
      ["plan has no readable expiry", plan({ expiresAt: "whenever" })],
      ["plan arrived already expired", plan({ expiresAt: "2026-08-01T11:00:00.000Z" })],
      [
        "two preconditions name one document",
        plan({ preconditions: [plan().preconditions[0]!, plan().preconditions[0]!] }),
      ],
      [
        "precondition names another workspace epoch",
        plan({ preconditions: [{ ...plan().preconditions[0]!, workspaceEpoch: 9 }] }),
      ],
      [
        "precondition is outside every workspace root",
        plan({
          preconditions: [{ ...plan().preconditions[0]!, uri: "file:///outside/a.ts" }],
          changes: [{ kind: "textEdit", uri: "file:///outside/a.ts", editCount: 1 }],
        }),
      ],
      [
        "two changes name one document",
        plan({
          changes: [
            { kind: "textEdit", uri: "file:///workspace/a.ts", editCount: 1 },
            { kind: "textEdit", uri: "file:///workspace/a.ts", editCount: 1 },
          ],
        }),
      ],
      [
        "change has no precondition on its document",
        plan({ changes: [{ kind: "textEdit", uri: "file:///workspace/b.ts", editCount: 1 }] }),
      ],
    ];

    for (const [reason, candidate] of refusals) {
      expect(() => store.createPlan(candidate, context)).toThrowError(
        expect.objectContaining({ code: "PROVIDER_FAILED", reason }),
      );
    }

    store.createPlan(plan(), context);
    expect(() => store.createPlan(plan(), context)).toThrowError(
      expect.objectContaining({ reason: "plan id repeats a live plan of this session" }),
    );
  });

  it("names the rule that refused an undo token", () => {
    const store = createStore();
    const token = (overrides: Partial<UndoToken> = {}): UndoToken => ({
      id: "undo_adapter_internal",
      adapterId: "adapter_fixture",
      sessionId: "session_adapter",
      workspaceId: "ws_fixture",
      ...overrides,
    });
    const refusals: [string, UndoToken][] = [
      ["undo token names another adapter", token({ adapterId: "adapter_other" })],
      ["undo token names another session", token({ sessionId: "session_other" })],
      ["undo token names another workspace", token({ workspaceId: "ws_other" })],
      ["undo token has no readable expiry", token({ expiresAt: "whenever" })],
      ["undo token arrived already expired", token({ expiresAt: "2026-08-01T11:00:00.000Z" })],
    ];

    for (const [reason, candidate] of refusals) {
      expect(() => store.createUndoToken(candidate, context)).toThrowError(
        expect.objectContaining({ code: "PROVIDER_FAILED", reason }),
      );
    }

    store.createUndoToken(token(), context);
    expect(() => store.createUndoToken(token(), context)).toThrowError(
      expect.objectContaining({ reason: "undo token id repeats a live token of this session" }),
    );
  });

  it("makes apply ownership private and consumption one-shot", () => {
    const store = createStore();
    store.createPlan(plan(), context);
    expect(() => store.consumePlan("plan_public", "session_other", "ws_fixture", 4)).toThrowError(
      expect.objectContaining({ code: "PLAN_NOT_FOUND" }),
    );
    const consumed = store.consumePlan("plan_public", "session_consumer", "ws_fixture", 4);
    expect(() =>
      store.consumePlan("plan_public", "session_consumer", "ws_fixture", 4),
    ).toThrowError(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));
    expect(() => store.createPlan(plan(), context)).toThrowError(
      expect.objectContaining({ code: "PROVIDER_FAILED" }),
    );
    store.releasePlan(consumed);
    expect(store.createPlan(plan(), context).planId).toBe("plan_public");
  });

  it("expires plans when the workspace epoch advances", () => {
    const store = createStore();
    store.createPlan(plan(), context);
    expect(() =>
      store.consumePlan("plan_public", "session_consumer", "ws_fixture", 5),
    ).toThrowError(expect.objectContaining({ code: "PLAN_EXPIRED" }));
    expect(store.planCount).toBe(0);
  });

  it("invalidates plans by document and session", () => {
    const store = createStore();
    store.createPlan(plan(), context);
    expect(store.invalidateDocument("ws_fixture", "file:///workspace/a.ts")).toBe(1);
    expect(store.planCount).toBe(0);

    store.createPlan(plan(), context);
    store.invalidateSession("session_adapter");
    expect(store.planCount).toBe(0);
  });

  it("tells a caller its own edit invalidated the plan, and which revision to prepare against", () => {
    // Measured in the VS Code end-to-end run: a plan invalidated by the consumer's own edit came
    // back as `PLAN_NOT_FOUND`, which reads as a mistyped identifier rather than as a consequence
    // of what the caller just did. The revision is what makes the refusal actionable.
    const store = createStore();
    store.createPlan(plan(), context);
    store.invalidateDocument("ws_fixture", "file:///workspace/a.ts", {
      version: 7,
      contentHash: "sha256:after-the-edit",
    });

    expect(() =>
      store.consumePlan("plan_public", "session_consumer", "ws_fixture", 1),
    ).toThrowError(
      expect.objectContaining({
        code: "STALE_DOCUMENT",
        stale: expect.objectContaining({
          uri: "file:///workspace/a.ts",
          currentRevision: { version: 7, contentHash: "sha256:after-the-edit" },
        }),
      }),
    );
  });

  it("still answers PLAN_NOT_FOUND when there is no revision to name", () => {
    // A deleted document has no current revision, so the protocol's `STALE_DOCUMENT` cannot be
    // formed for it. The plan is genuinely gone, and that is what is said.
    const store = createStore();
    store.createPlan(plan(), context);
    store.invalidateDocument("ws_fixture", "file:///workspace/a.ts");

    expect(() =>
      store.consumePlan("plan_public", "session_consumer", "ws_fixture", 1),
    ).toThrowError(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));
  });

  it("rewrites and consumes exact undo tokens once", () => {
    const store = createStore();
    const adapterToken: UndoToken = {
      id: "undo_adapter_internal",
      adapterId: "adapter_fixture",
      sessionId: "session_adapter",
      workspaceId: "ws_fixture",
      expiresAt: "2026-08-01T12:10:00.000Z",
    };
    const publicToken = store.createUndoToken(adapterToken, context);
    expect(publicToken).toMatchObject({
      id: "undo_public",
      sessionId: "session_consumer",
      expiresAt: "2026-08-01T12:01:00.000Z",
    });
    const reorderedToken: UndoToken = {
      workspaceId: publicToken.workspaceId,
      sessionId: publicToken.sessionId,
      adapterId: publicToken.adapterId,
      id: publicToken.id,
      expiresAt: publicToken.expiresAt,
    };
    const consumed = store.consumeUndoToken(reorderedToken, "session_consumer", "ws_fixture");
    expect(consumed.adapterToken).toEqual(adapterToken);
    expect(() =>
      store.consumeUndoToken(publicToken, "session_consumer", "ws_fixture"),
    ).toThrowError(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));
    expect(() => store.createUndoToken(adapterToken, context)).toThrowError(
      expect.objectContaining({ code: "PROVIDER_FAILED" }),
    );
    store.releaseUndoToken(consumed);
    expect(store.createUndoToken(adapterToken, context).id).toBe("undo_public");
    expect(store.undoTokenCount).toBe(1);
    store.invalidateWorkspace("ws_fixture");
    expect(store.undoTokenCount).toBe(0);
  });
});
