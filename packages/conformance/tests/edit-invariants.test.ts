import type { EditPlan, Workspace } from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import { checkEditPlan, checkModification } from "../src/invariants.js";

/** Each rule is proven by the defect it targets, not only by input that already satisfies it. */

const workspace: Workspace = {
  workspaceId: "ws_1",
  adapterId: "adapter_1",
  name: "demo",
  roots: [{ rootId: "root_1", name: "demo", uri: "file:///projects/demo" }],
  workspaceEpoch: 3,
  trust: "trusted",
};

const uri = "file:///projects/demo/src/Service.java";

const plan = (over: Partial<EditPlan> = {}): EditPlan => ({
  planId: "plan_1",
  adapterId: "adapter_1",
  sessionId: "session_1",
  workspaceId: "ws_1",
  expiresAt: "2026-08-07T12:02:00Z",
  operation: "rename",
  guarantee: "semantic",
  atomicity: "semantic",
  preconditions: [
    { type: "documentRevision", uri, contentHash: `sha256:${"a".repeat(64)}`, workspaceEpoch: 3 },
  ],
  changes: [{ kind: "textEdit", uri, editCount: 2 }],
  warnings: [],
  ...over,
});

const subject = (over: Partial<EditPlan> = {}) => ({
  workspace,
  adapterId: "adapter_1",
  sessionId: "session_1",
  plan: plan(over),
});

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);

describe("edit plan invariants", () => {
  it("accepts a well-formed plan", () => {
    expect(checkEditPlan(subject())).toEqual([]);
  });

  it("catches a plan bound to another session", () => {
    expect(rules(checkEditPlan(subject({ sessionId: "session_other" })))).toContain(
      "plan.bound-to-session",
    );
  });

  it("catches a plan that promises no change", () => {
    // A success carrying nothing reads as "done" to a consumer that in fact got a refusal.
    expect(rules(checkEditPlan(subject({ changes: [], preconditions: [] })))).toContain(
      "plan.changes-something",
    );
  });

  it("catches a change outside every root", () => {
    const outside = subject({
      changes: [{ kind: "textEdit", uri: "file:///elsewhere/Other.java", editCount: 1 }],
    });

    expect(rules(checkEditPlan(outside))).toContain("plan.changes-within-a-root");
  });

  it("catches a precondition guarding a document the plan never touches", () => {
    const misguarded = subject({
      preconditions: [
        {
          type: "documentRevision",
          uri: "file:///projects/demo/src/Other.java",
          contentHash: `sha256:${"a".repeat(64)}`,
          workspaceEpoch: 3,
        },
      ],
    });

    // Protects nothing, and leaves what the plan does rewrite unguarded.
    expect(rules(checkEditPlan(misguarded))).toContain("plan.precondition-covers-a-change");
  });

  it("catches a precondition pinned to a stale epoch", () => {
    const stale = subject({
      preconditions: [
        {
          type: "documentRevision",
          uri,
          contentHash: `sha256:${"a".repeat(64)}`,
          workspaceEpoch: 1,
        },
      ],
    });

    expect(rules(checkEditPlan(stale))).toContain("plan.precondition-current-epoch");
  });

  it("catches an expiry that is not a timestamp", () => {
    expect(rules(checkEditPlan(subject({ expiresAt: "soon" })))).toContain(
      "plan.expiry-is-a-timestamp",
    );
  });
});

describe("modification invariants", () => {
  const document = {
    workspaceId: "ws_1",
    rootId: "root_1",
    uri,
    logicalPath: "src/Service.java",
    revision: { editorVersion: 2, contentHash: `sha256:${"c".repeat(64)}`, workspaceEpoch: 3 },
    positionEncoding: "utf-16" as const,
    isDirty: false,
  };

  it("accepts a modification the plan named", () => {
    expect(
      checkModification({
        workspace,
        plan: plan(),
        modifiedDocuments: [
          {
            document,
            beforeHash: `sha256:${"a".repeat(64)}`,
            afterHash: `sha256:${"b".repeat(64)}`,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("catches a document changed that the plan never named", () => {
    const unplanned = { ...document, uri: "file:///projects/demo/src/Other.java" };

    // The failure two phases exist to prevent: the consumer approved something else.
    expect(
      rules(
        checkModification({
          workspace,
          plan: plan(),
          modifiedDocuments: [
            {
              document: unplanned,
              beforeHash: `sha256:${"a".repeat(64)}`,
              afterHash: `sha256:${"b".repeat(64)}`,
            },
          ],
        }),
      ),
    ).toContain("modification.was-planned");
  });

  it("catches a modification that changed nothing", () => {
    const same = `sha256:${"a".repeat(64)}`;

    // Reporting an unchanged document as modified would have a consumer believe an edit landed.
    expect(
      rules(
        checkModification({
          workspace,
          plan: plan(),
          modifiedDocuments: [{ document, beforeHash: same, afterHash: same }],
        }),
      ),
    ).toContain("modification.actually-changed");
  });
});
