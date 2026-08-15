/**
 * End-to-end scenario, executed inside a real VS Code extension host.
 *
 * Everything else in this package tests the adapter against a simulated host. This file is the only
 * place where the whole chain runs for real: VS Code activates the extension, the extension starts a
 * daemon over loopback and registers, and a separate consumer client drives the protocol against the
 * deterministic TypeScript fixture project.
 *
 * The rename scenario is driven by `packages/protocol/fixtures/languages/typescript.expected.json`
 * rather than by expectations invented here, so this test verifies the contract Phase 1 declared:
 * renaming `Circle` to `RoundShape` must touch exactly the three files that fixture names.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";
import {
  connectBridgeClientFromDiscoveryFile,
  type AuthenticatedBridgeConnection,
} from "@ide-bridge/bridge-client";
import { resolveDiscoveryFilePath } from "@ide-bridge/cli";
import { checkDocumentSymbols, checkWorkspace } from "@ide-bridge/conformance";
import type {
  DocumentReference,
  ErrorCode,
  Symbol as IDEBPSymbol,
  Workspace,
  WorkspaceId,
} from "@ide-bridge/protocol";

import expected from "../../../../protocol/fixtures/languages/typescript.expected.json";

const EXTENSION_ID = "ide-bridge.vscode-extension";
const ACTIVATION_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;

let consumer: AuthenticatedBridgeConnection | undefined;
let workspaceId: WorkspaceId;
let registeredWorkspace: Workspace;
let adapterSessionId: string;

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((done) => setTimeout(done, 250));
  }
}

/**
 * The protocol code lives on the typed error, not in its message, so assertions match on it
 * directly rather than on prose that could change without the contract changing.
 */
function rejectsWith(...codes: ErrorCode[]): (error: unknown) => boolean {
  return (error: unknown) => {
    const actual = (error as { protocolCode?: ErrorCode }).protocolCode;
    assert.ok(
      actual !== undefined && codes.includes(actual),
      `expected one of ${codes.join(", ")}, got ${String(actual)} (${String(error)})`,
    );
    return true;
  };
}

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test window must open the TypeScript fixture project");
  return folder.uri;
}

/** Rewrites a fixture URI onto the root this test window actually opened. */
function localUri(fixtureUri: string): string {
  const relative = fixtureUri.slice(`${expected.workspaceRootUri}/`.length);
  return vscode.Uri.joinPath(workspaceRoot(), ...relative.split("/")).toString();
}

suite("IDE Bridge end-to-end", function () {
  this.timeout(180_000);

  /**
   * Real responses, recorded where `packages/conformance` can read them.
   *
   * The suite already applies the conformance rules inline, but the rules had only ever judged
   * JetBrains *captures* — so a contract meant to hold across IDEs was, in that file, checked
   * against one. Writing this one is what makes the comparison real.
   */
  const capture: Record<string, unknown> = { adapter: "vscode" };

  suiteTeardown(() => {
    // Written once at the end: a run that fails midway leaves the previous capture rather than a
    // partial one that would read as conformant.
    if (Object.keys(capture).length <= 1) return;
    // Anchored on the extension's own installed path rather than a count of `..` from a compiled
    // test file — the first attempt guessed the depth wrong, and the silent catch below hid it, so
    // the capture was simply never written and nothing said so.
    const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
    if (extensionPath === undefined) return;
    const target = join(extensionPath, "..", "conformance", "captures", "vscode.json");
    try {
      writeFileSync(target, `${JSON.stringify(capture, null, 2)}\n`);
    } catch (error) {
      // A capture is evidence, not a requirement of the run, so this does not fail the suite. It
      // is reported rather than swallowed: a capture that silently never lands looks exactly like
      // one that was written and passed.
      console.error(`[e2e] could not write the conformance capture to ${target}:`, error);
    }
  });

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();

    // The extension auto-starts the daemon; the consumer joins the same authenticated endpoint.
    //
    // `undefined`, not `""`: the empty string is a path the resolver treats as "none configured
    // either way" and answers with the shared file under $HOME, so this suite silently attached to
    // whatever daemon the developer happened to be running — for three days, on another build.
    const discoveryFile = resolveDiscoveryFilePath(undefined);
    await waitUntil("the extension to publish an authenticated daemon", async () => {
      try {
        consumer = await connectBridgeClientFromDiscoveryFile(discoveryFile, {
          role: "consumer",
          topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
          clientInfo: { name: "ide-bridge-e2e", version: "0.1.0" },
        });
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(consumer, "consumer client did not connect");

    await waitUntil("the adapter to register its workspace", async () => {
      const listed = await consumer?.request(
        "workspace/list",
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      const first = listed?.workspaces[0];
      if (first === undefined) return false;
      workspaceId = first.workspaceId;
      registeredWorkspace = first;
      return true;
    });
  });

  test("the registered workspace satisfies the conformance rules", async () => {
    assert.ok(consumer);
    const adapters = await consumer.request(
      "bridge/listAdapters",
      {},
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    const adapter = adapters.adapters.find((a) => a.adapterId === registeredWorkspace.adapterId);
    assert.ok(adapter, "the daemon must know the adapter that registered the workspace");
    adapterSessionId = adapter.sessionId;

    assert.deepEqual(
      checkWorkspace(registeredWorkspace),
      [],
      "a workspace that breaks these rules makes every later response unverifiable",
    );

    // The daemon starts every workspace at `initializing` and leaves it there until the adapter
    // says otherwise. This one never did, so a VS Code workspace read `initializing` for as long as
    // it was open — and a consumer polling for `ready` waited for a transition that was never
    // coming. The daemon answers this from the adapter's announcement, so asking it here is asking
    // whether the announcement was made.
    const status = await consumer.request(
      "workspace/getStatus",
      { workspaceId: registeredWorkspace.workspaceId },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    assert.equal(
      status.status.state,
      "ready",
      "a registered VS Code workspace must report itself ready, not still initializing",
    );

    capture["workspace"] = registeredWorkspace;
  });

  suiteTeardown(async () => {
    await consumer?.close();
  });

  test("reads a fixture document with a revision from the live buffer", async () => {
    assert.ok(consumer);
    const declared = expected.symbols[0];
    assert.ok(declared, "the language contract must declare at least one symbol");
    const uri = localUri(declared.uri);
    const result = await consumer.request(
      "document/read",
      { workspaceId, uri },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    assert.equal(result.document.uri, uri);
    assert.match(result.document.revision.contentHash, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(result.text.includes("Circle"), "fixture content should be readable");
  });

  test("returns the symbols the language contract declares, at the declared ranges", async () => {
    assert.ok(consumer);
    for (const declared of expected.symbols) {
      const uri = localUri(declared.uri);
      const result = await consumer.request(
        "document/getSymbols",
        { workspaceId, uri },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );

      // Bound to their protocol types before use: passing the response's properties straight
      // into a call while its own type was still being inferred made the inference circular.
      const document: DocumentReference = result.document;
      const symbols: readonly IDEBPSymbol[] = result.symbols;
      // The first document is enough for the capture: the rules are shape rules, and recording
      // every file would grow the evidence without widening what it proves.
      capture["requestedUri"] ??= uri;
      capture["documentSymbols"] ??= { document, symbols };

      const flat: { name: string; kind: string; selectionRange: unknown }[] = [];
      const visit = (symbols: readonly IDEBPSymbol[]): void => {
        for (const symbol of symbols) {
          flat.push({
            name: symbol.locator.name,
            kind: symbol.locator.kind,
            selectionRange: symbol.locator.selectionRange,
          });
          visit(symbol.children);
        }
      };
      visit(symbols);

      // The rules every adapter must satisfy, applied to a real provider's real answer. The
      // assertions below check what *this* language contract declares; these check what the
      // protocol requires of anyone.
      assert.deepEqual(
        checkDocumentSymbols({
          workspace: registeredWorkspace,
          adapterId: registeredWorkspace.adapterId,
          sessionId: adapterSessionId,
          requestedUri: uri,
          document,
          symbols,
        }),
        [],
        `conformance violations for ${uri}`,
      );

      const match = flat.find((symbol) => symbol.name === declared.name);
      assert.ok(match, `expected ${declared.name} in ${uri}, got ${JSON.stringify(flat)}`);
      assert.equal(match.kind, declared.kind, `kind mismatch for ${declared.name}`);
      assert.deepEqual(
        match.selectionRange,
        declared.selectionRange,
        `selection range mismatch for ${declared.name}`,
      );
    }
  });

  test("finds the rename target across the workspace and lists its references", async () => {
    assert.ok(consumer);
    const search = await consumer.request(
      "workspace/searchSymbols",
      { workspaceId, query: expected.rename.targetQualifiedName, limit: 50 },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const hit = search.symbols.find(
      (symbol) => symbol.locator.name === expected.rename.targetQualifiedName,
    );
    assert.ok(hit, "workspace search must find the declared rename target");

    const references = await consumer.request(
      "symbol/getReferences",
      { workspaceId, symbol: { handle: hit.handle, locator: hit.locator } },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const files = new Set(references.locations.map((entry) => entry.location.uri));
    assert.ok(files.size > 1, "the declared target is referenced from more than one file");
  });

  test("answers a hierarchy step and records it for the conformance suite", async () => {
    assert.ok(consumer);
    // Resolved through `document/getSymbols`, not workspace search. A workspace-search hit carries
    // the declaration's start — column 0 — and `prepareCallHierarchy` needs a position *on the
    // identifier*, so it answered with nothing. Measured, not guessed: the provider was logging an
    // empty preparation for `line 58, character 0`.
    const typesUri = localUri(`${expected.workspaceRootUri}/src/types.ts`);
    const declared = await consumer.request(
      "document/getSymbols",
      { workspaceId, uri: typesUri },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const flat: typeof declared.symbols = [];
    const walk = (symbol: (typeof declared.symbols)[number]): void => {
      flat.push(symbol);
      symbol.children.forEach(walk);
    };
    declared.symbols.forEach(walk);
    const hit = flat.find((symbol) => symbol.locator.name.startsWith("circumference"));
    if (hit === undefined) {
      assert.fail(
        `types.ts declared ${flat.map((symbol) => symbol.locator.name).join(", ")} — none of them the called function`,
      );
    }

    const hierarchy = await consumer.request(
      "symbol/getHierarchy",
      { workspaceId, symbol: { handle: hit.handle, locator: hit.locator }, relation: "callers" },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    // The daemon accepted it, which is what a unit test cannot show: every reported URI had to
    // survive the containment check or this session would already be closed.
    assert.ok(Array.isArray(hierarchy.locations), "a hierarchy step must answer with locations");
    // The assertion that keeps the recorded capture worth judging: an empty list would satisfy
    // every conformance rule and demonstrate nothing.
    assert.ok(
      hierarchy.locations.length > 0,
      "the fixture calls this function, so its callers must not be empty",
    );
    assert.strictEqual(
      hierarchy.truncated && hierarchy.locations.length === 0,
      false,
      "truncation cannot be claimed over an empty result",
    );

    // Recorded so `packages/conformance` judges two adapters by one rule set. Until now it had
    // only JetBrains responses to check, which is half of what a cross-IDE contract is for.
    capture["hierarchy"] = hierarchy;
  });

  test("answers a hierarchy from a workspace-search handle, whose position is coarse", async () => {
    assert.ok(consumer);
    // The case that used to return nothing. A search hit carries the declaration's start, column 0,
    // and `prepareCallHierarchy` needs the identifier — so the adapter moves the position onto the
    // name before asking. Without that a consumer got an empty list and no indication why.
    const search = await consumer.request(
      "workspace/searchSymbols",
      { workspaceId, query: "circumference", limit: 50 },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const hit = search.symbols.find((symbol) => symbol.locator.name.startsWith("circumference"));
    assert.ok(hit, "workspace search must find the fixture's called function");
    assert.strictEqual(
      hit.locator.selectionRange.start.character,
      0,
      "this test is only meaningful while a search handle really does carry a coarse position",
    );

    const hierarchy = await consumer.request(
      "symbol/getHierarchy",
      { workspaceId, symbol: { handle: hit.handle, locator: hit.locator }, relation: "callers" },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    assert.ok(
      hierarchy.locations.length > 0,
      "a coarse handle must still answer, or the refinement is not doing its job",
    );
  });

  test("renames across exactly the declared files and writes them to disk", async () => {
    assert.ok(consumer);
    const declaringSymbol = expected.symbols[0];
    assert.ok(declaringSymbol, "the language contract must declare the rename target's document");
    const declarationUri = localUri(declaringSymbol.uri);
    const symbols = await consumer.request(
      "document/getSymbols",
      { workspaceId, uri: declarationUri },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const target = symbols.symbols.find(
      (symbol) => symbol.locator.name === expected.rename.targetQualifiedName,
    );
    assert.ok(target, "fixture must expose the declared rename target");

    const prepared = await consumer.request(
      "refactor/prepareRename",
      {
        workspaceId,
        symbol: { handle: target.handle, locator: target.locator },
        newName: expected.rename.newName,
        options: { includeComments: false, includeStrings: false },
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const plan = prepared.plan;
    capture["editPlan"] = plan;
    assert.equal(plan.guarantee, expected.rename.guarantee);
    assert.ok(
      plan.warnings.some((warning) => warning.includes("cannot be undone")),
      "the plan must warn that applying is irreversible",
    );
    assert.deepEqual(
      plan.changes.map((change) => change.uri).sort(),
      expected.rename.affectedUris.map(localUri).sort(),
      "the plan must touch exactly the declared files",
    );

    const applied = await consumer.request(
      "workspace/applyPlan",
      { workspaceId, planId: plan.planId },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    capture["modification"] = { modifiedDocuments: applied.modifiedDocuments };
    for (const modified of applied.modifiedDocuments) {
      assert.notEqual(modified.beforeHash, modified.afterHash, "each file must actually change");
    }
    // VS Code cannot revert an applied workspace edit, so no undo token is ever issued.
    assert.equal(applied.undoToken, undefined);

    // The adapter saves after applying, so the rename must be observable on disk.
    for (const fixtureUri of expected.rename.affectedUris) {
      const filePath = vscode.Uri.parse(localUri(fixtureUri)).fsPath;
      assert.ok(
        readFileSync(filePath, "utf8").includes(expected.rename.newName),
        `${filePath} should contain ${expected.rename.newName} after the rename`,
      );
    }

    // A plan is one-shot.
    await assert.rejects(
      async () =>
        await consumer?.request(
          "workspace/applyPlan",
          { workspaceId, planId: plan.planId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        ),
      rejectsWith("PLAN_NOT_FOUND", "PLAN_EXPIRED"),
    );
  });

  // TASK.md §30 step 12. It answered `PLAN_NOT_FOUND` for three days, and every explanation
  // offered for that — the debounce, the bundled build, a URI mismatch, a missing revision, a
  // silently dropped notification — was wrong.
  //
  // The suite was not talking to the daemon it built. `readAdapterConfiguration` passed the
  // discovery-file *setting* straight through, and its declared default is the empty string, which
  // the resolver reads as a configured value rather than an absence. So `IDE_BRIDGE_DISCOVERY_FILE`
  // — set by the launcher precisely to sandbox this run — was never consulted, and both the
  // extension and this consumer attached to `$HOME/.ide-bridge/discovery.json`: a daemon started by
  // hand three days earlier, from a build with no `STALE_DOCUMENT` in it at all.
  //
  // Every check that "eliminated" a suspect was run against the wrong process. The daemon under
  // test was never in the room. Measured after the fix: `STALE_DOCUMENT`, on the first run.
  //
  // Both codes are accepted because the step is a protocol contract, not a VS Code assertion:
  // an adapter that refuses on its own precondition rather than on the daemon's record answers
  // `PRECONDITION_FAILED`, and that is equally correct.
  test("refuses a plan whose document changed after it was prepared", async () => {
    assert.ok(consumer);
    const declaringSymbol = expected.symbols[0];
    assert.ok(declaringSymbol);
    const declarationUri = localUri(declaringSymbol.uri);

    const symbols = await consumer.request(
      "document/getSymbols",
      { workspaceId, uri: declarationUri },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const target = symbols.symbols[0];
    assert.ok(target, "the fixture document must declare at least one symbol to rename");

    const prepared = await consumer.request(
      "refactor/prepareRename",
      {
        workspaceId,
        symbol: { handle: target.handle, locator: target.locator },
        newName: `${target.locator.name}Renamed`,
        options: { includeComments: false, includeStrings: false },
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    // The daemon broadcasts every adapter notification to its consumers, so this connection sees
    // exactly what the daemon saw. Without it, "the plan was not invalidated" and "the daemon was
    // never told" are the same observation — which is what made this scenario unreadable for days.
    const changesSeen: string[] = [];
    const unsubscribe = consumer.onNotification("document/changed", (params) => {
      changesSeen.push(params.document.uri);
    });

    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(declarationUri));
    const dirtying = new vscode.WorkspaceEdit();
    const marker = "// changed while a plan was open\n";
    dirtying.insert(document.uri, new vscode.Position(0, 0), marker);
    assert.ok(await vscode.workspace.applyEdit(dirtying), "the fixture edit must apply");

    // `document/changed` is debounced by 75 ms in the event bridge, so applying immediately would
    // race the notification. Found by watching the first version of this test refuse with
    // PLAN_NOT_FOUND while the store, unit-tested, answered STALE_DOCUMENT correctly.
    await new Promise((resolve) => setTimeout(resolve, 750));

    // Kept as an assertion rather than as the console diagnostic it started as: whatever the
    // refusal turns out to be, the IDE must have seen the edit for the question to mean anything.
    const afterEdit = await consumer.request(
      "document/read",
      { workspaceId, uri: declarationUri },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const precondition = prepared.plan.preconditions.find(
      (candidate) => candidate.uri === declarationUri,
    );
    assert.ok(precondition, "the plan must have a precondition on the document it edits");
    assert.notEqual(
      afterEdit.document.revision.contentHash,
      precondition.contentHash,
      "the IDE must have seen the edit, or this scenario tests nothing",
    );
    unsubscribe();
    assert.ok(
      changesSeen.includes(declarationUri),
      `the daemon was never told the document changed; it saw ${JSON.stringify(changesSeen)}`,
    );

    try {
      // The plan describes offsets in a document that no longer exists in that form. Applying it
      // would write the right text in the wrong place, which is the failure this refusal prevents.
      await assert.rejects(
        async () =>
          await consumer?.request(
            "workspace/applyPlan",
            { workspaceId, planId: prepared.plan.planId },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
        rejectsWith("STALE_DOCUMENT", "PRECONDITION_FAILED"),
      );
    } finally {
      const undoing = new vscode.WorkspaceEdit();
      undoing.delete(
        document.uri,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
      );
      await vscode.workspace.applyEdit(undoing);
    }
  });

  test("refuses to read a document outside every workspace root", async () => {
    assert.ok(consumer);
    await assert.rejects(
      async () =>
        await consumer?.request(
          "document/read",
          { workspaceId, uri: "file:///etc/hosts" },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        ),
      rejectsWith("DOCUMENT_NOT_FOUND", "PERMISSION_DENIED"),
    );
  });
});
