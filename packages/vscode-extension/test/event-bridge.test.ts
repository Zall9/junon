import {
  classifyIDEBPNotification,
  type AdapterId,
  type IDEBPNotificationMethod,
  type IDEBPNotificationParams,
  type RootId,
  type WorkspaceId,
} from "@ide-bridge/protocol";
import { describe, expect, it } from "vitest";

import type { VscodeDocumentUriLike, VscodeTextDocumentLike } from "../src/document-mapper.js";
import { VscodeDocumentRoutes } from "../src/document-routes.js";
import type {
  AdapterNotifier,
  VscodeDisposableLike,
  VscodeDocumentChangeEventLike,
  VscodeEventHost,
} from "../src/event-bridge.js";
import { VscodeEventBridge } from "../src/event-bridge.js";
import type { VscodeWorkspaceFolderLike } from "../src/workspace-model.js";
import { VscodeWorkspaceModel } from "../src/workspace-model.js";

function uri(value: string): VscodeDocumentUriLike {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: decodeURIComponent(parsed.pathname),
    toString: () => value,
  };
}

class FakeEventHost implements VscodeEventHost {
  textDocuments: VscodeTextDocumentLike[] = [];
  readonly openListeners = new Set<(document: VscodeTextDocumentLike) => unknown>();
  readonly changeListeners = new Set<(event: VscodeDocumentChangeEventLike) => unknown>();
  readonly saveListeners = new Set<(document: VscodeTextDocumentLike) => unknown>();
  readonly closeListeners = new Set<(document: VscodeTextDocumentLike) => unknown>();
  readonly folderListeners = new Set<() => unknown>();
  readonly renameListeners = new Set<
    (event: {
      readonly files: readonly {
        readonly oldUri: { toString(): string };
        readonly newUri: { toString(): string };
      }[];
    }) => unknown
  >();
  readonly deleteListeners = new Set<
    (event: { readonly files: readonly { toString(): string }[] }) => unknown
  >();
  readonly trustListeners = new Set<() => unknown>();

  onDidOpenTextDocument(listener: (document: VscodeTextDocumentLike) => unknown) {
    return disposable(this.openListeners, listener);
  }

  onDidChangeTextDocument(listener: (event: VscodeDocumentChangeEventLike) => unknown) {
    return disposable(this.changeListeners, listener);
  }

  onDidSaveTextDocument(listener: (document: VscodeTextDocumentLike) => unknown) {
    return disposable(this.saveListeners, listener);
  }

  onDidCloseTextDocument(listener: (document: VscodeTextDocumentLike) => unknown) {
    return disposable(this.closeListeners, listener);
  }

  onDidChangeWorkspaceFolders(listener: () => unknown) {
    return disposable(this.folderListeners, listener);
  }

  onDidRenameFiles(
    listener: (event: {
      readonly files: readonly {
        readonly oldUri: { toString(): string };
        readonly newUri: { toString(): string };
      }[];
    }) => unknown,
  ) {
    return disposable(this.renameListeners, listener);
  }

  onDidDeleteFiles(
    listener: (event: { readonly files: readonly { toString(): string }[] }) => unknown,
  ) {
    return disposable(this.deleteListeners, listener);
  }

  onDidGrantWorkspaceTrust(listener: () => unknown) {
    return disposable(this.trustListeners, listener);
  }
}

class RecordingNotifier implements AdapterNotifier {
  readonly notifications: Array<{
    method: IDEBPNotificationMethod;
    params: IDEBPNotificationParams<IDEBPNotificationMethod>;
  }> = [];
  #blockedMethod: IDEBPNotificationMethod | undefined;
  #releaseBlocked: (() => void) | undefined;
  #markStarted: (() => void) | undefined;
  #failingMethod: IDEBPNotificationMethod | undefined;

  /** Makes the next send of `method` reject, as a closed connection would. */
  failNext(method: IDEBPNotificationMethod): void {
    this.#failingMethod = method;
  }

  block(method: IDEBPNotificationMethod): { started: Promise<void>; release(): void } {
    this.#blockedMethod = method;
    const started = new Promise<void>((resolve) => {
      this.#markStarted = resolve;
    });
    return {
      started,
      release: () => this.#releaseBlocked?.(),
    };
  }

  async notify<M extends IDEBPNotificationMethod>(
    method: M,
    params: IDEBPNotificationParams<M>,
  ): Promise<void> {
    const notification = { jsonrpc: "2.0", method, params };
    expect(classifyIDEBPNotification(notification)).toMatchObject({ kind: "valid", method });
    if (this.#failingMethod === method) {
      this.#failingMethod = undefined;
      throw new Error("connection is closed");
    }
    if (this.#blockedMethod === method) {
      this.#markStarted?.();
      await new Promise<void>((resolve) => {
        this.#releaseBlocked = resolve;
      });
      this.#blockedMethod = undefined;
      this.#releaseBlocked = undefined;
      this.#markStarted = undefined;
    }
    this.notifications.push({
      method,
      params: structuredClone(params) as IDEBPNotificationParams<IDEBPNotificationMethod>,
    });
  }
}

function disposable<T>(set: Set<T>, value: T): VscodeDisposableLike {
  set.add(value);
  return { dispose: () => set.delete(value) };
}

function fixture(options: { readonly live?: boolean } = {}) {
  const api: VscodeWorkspaceFolderLike = {
    name: "api",
    uri: uri("file:///workspace/api"),
  };
  const web: VscodeWorkspaceFolderLike = {
    name: "web",
    uri: uri("file:///workspace/web"),
  };
  let folders: VscodeWorkspaceFolderLike[] = [api];
  let trusted = true;
  const model = new VscodeWorkspaceModel(
    "adapter_events" as AdapterId,
    "ws_events" as WorkspaceId,
    (() => {
      let next = 0;
      return () => `root_events_${++next}` as RootId;
    })(),
  );
  const currentWorkspaces = () => model.snapshot(folders, { trusted });
  const registered = currentWorkspaces();
  let projectedWorkspace = registered[0];
  let text = "one";
  let version = 1;
  let mappingFails = false;
  const document: VscodeTextDocumentLike = {
    uri: uri("file:///workspace/api/src/value.ts"),
    get version() {
      return version;
    },
    languageId: "typescript",
    get isDirty() {
      return true;
    },
    getText: () => {
      if (mappingFails) throw new Error("buffer is gone");
      return text;
    },
  };
  const outside: VscodeTextDocumentLike = {
    ...document,
    uri: uri("file:///elsewhere/notes.ts"),
    getText: () => text,
  };
  // The one the live run actually produces: VS Code's own chat input buffer.
  const editorBuffer: VscodeTextDocumentLike = {
    ...document,
    uri: {
      scheme: "chatSessionInput",
      authority: "",
      path: "input-0",
      toString: () => "chatSessionInput:input-0",
    },
    languageId: "plaintext",
    getText: () => text,
  };
  const inWeb: VscodeTextDocumentLike = {
    ...document,
    uri: uri("file:///workspace/web/src/value.ts"),
    getText: () => text,
  };
  const host = new FakeEventHost();
  host.textDocuments = [document];
  const changedUris: string[] = [];
  const renamedUris: [string, string][] = [];
  const deletedUris: string[] = [];
  const drops: { method: string; reason: string }[] = [];
  const routes = new VscodeDocumentRoutes({
    host: {
      parseUri: (value) => uri(value),
      getWorkspaceFolder: (candidate) =>
        folders.find((folder) => candidate.toString().startsWith(`${folder.uri.toString()}/`)),
      openTextDocument: async () => document,
    },
    workspaceModel: model,
    currentWorkspace: () => projectedWorkspace,
  });
  const bridge = new VscodeEventBridge({
    host,
    documentRoutes: routes,
    currentWorkspaces,
    documentChanged: (uri) => changedUris.push(uri),
    documentRenamed: (previous, current) => renamedUris.push([previous, current]),
    documentDeleted: (uri) => deletedUris.push(uri),
    workspaceProjectionChanged: (workspace) => {
      projectedWorkspace = workspace;
    },
    documentEventDropped: (method, reason) => drops.push({ method, reason }),
  });
  const notifier = new RecordingNotifier();
  if (options.live !== false) bridge.setLiveNotifier(notifier);
  return {
    bridge,
    changedUris,
    deletedUris,
    document,
    drops,
    editorBuffer,
    inWeb,
    outside,
    breakMapping() {
      mappingFails = true;
    },
    clearProjection() {
      projectedWorkspace = undefined;
    },
    renamedUris,
    grantTrust() {
      trusted = true;
    },
    setUntrusted() {
      trusted = false;
    },
    host,
    notifier,
    projectedEpoch: () => projectedWorkspace?.workspaceEpoch,
    registered,
    setDocument(nextText: string, nextVersion: number) {
      text = nextText;
      version = nextVersion;
    },
    setFolders(nextFolders: VscodeWorkspaceFolderLike[]) {
      folders = nextFolders;
    },
    web,
  };
}

describe("VS Code event bridge", () => {
  it("publishes current documents and coalesces changes to the latest revision", async () => {
    const state = fixture();
    await state.bridge.synchronize(state.notifier, state.registered);
    // Only the document notifications: synchronising also announces the workspace's readiness, and
    // that is a separate fact with a test of its own.
    expect(
      state.notifier.notifications.filter((entry) => entry.method.startsWith("document/")),
    ).toMatchObject([
      {
        method: "document/opened",
        params: { document: { revision: { editorVersion: 1 } } },
      },
    ]);

    state.notifier.notifications.length = 0;
    state.setDocument("two", 2);
    for (const listener of state.host.changeListeners) listener({ document: state.document });
    state.setDocument("three", 3);
    for (const listener of state.host.changeListeners) listener({ document: state.document });
    await waitUntil(() => state.notifier.notifications.length === 1);

    expect(state.changedUris).toEqual([
      "file:///workspace/api/src/value.ts",
      "file:///workspace/api/src/value.ts",
    ]);
    expect(state.notifier.notifications).toMatchObject([
      {
        method: "document/changed",
        params: { document: { revision: { editorVersion: 3 } } },
      },
    ]);
    state.bridge.dispose();
  });

  it("flushes a pending change before save and preserves notification order", async () => {
    const state = fixture();
    await state.bridge.synchronize(state.notifier, state.registered);
    state.notifier.notifications.length = 0;
    state.setDocument("saved", 2);
    for (const listener of state.host.changeListeners) listener({ document: state.document });
    for (const listener of state.host.saveListeners) listener(state.document);
    await waitUntil(() => state.notifier.notifications.length === 2);

    expect(state.notifier.notifications.map(({ method }) => method)).toEqual([
      "document/changed",
      "document/saved",
    ]);
    state.bridge.dispose();
  });

  it("maps non-empty root changes and the empty-window transition honestly", async () => {
    const state = fixture();
    state.host.textDocuments = [];
    await state.bridge.synchronize(state.notifier, state.registered);
    state.notifier.notifications.length = 0;

    const blocked = state.notifier.block("workspace/rootsChanged");
    state.setFolders([{ name: "api", uri: uri("file:///workspace/api") }, state.web]);
    for (const listener of state.host.folderListeners) listener();
    await blocked.started;
    expect(state.projectedEpoch()).toBe(0);
    blocked.release();
    await waitUntil(() => state.notifier.notifications.length === 1);
    expect(state.projectedEpoch()).toBe(1);
    expect(state.notifier.notifications[0]).toMatchObject({
      method: "workspace/rootsChanged",
      params: { roots: [{ name: "api" }, { name: "web" }], workspaceEpoch: 1 },
    });

    state.setFolders([]);
    for (const listener of state.host.folderListeners) listener();
    await waitUntil(() => state.notifier.notifications.length === 2);
    expect(state.notifier.notifications[1]).toMatchObject({
      method: "workspace/closed",
      params: { workspaceId: "ws_events", adapterId: "adapter_events" },
    });
    state.bridge.dispose();
  });

  it("announces a renamed document with its previous URI and invalidates both", async () => {
    const state = fixture();
    await state.bridge.synchronize(state.notifier, state.registered);
    const before = state.notifier.notifications.length;

    for (const listener of state.host.renameListeners) {
      listener({
        files: [
          {
            oldUri: uri("file:///workspace/api/src/old.ts"),
            newUri: uri("file:///workspace/api/src/value.ts"),
          },
        ],
      });
    }
    await waitUntil(() => state.notifier.notifications.length > before);

    expect(state.notifier.notifications[before]).toMatchObject({
      method: "document/renamed",
      params: {
        workspaceId: "ws_events",
        previousUri: "file:///workspace/api/src/old.ts",
        document: { uri: "file:///workspace/api/src/value.ts" },
      },
    });
    expect(state.renamedUris).toEqual([
      ["file:///workspace/api/src/old.ts", "file:///workspace/api/src/value.ts"],
    ]);
    state.bridge.dispose();
  });

  it("announces a deleted document without claiming a revision it cannot have", async () => {
    const state = fixture();
    await state.bridge.synchronize(state.notifier, state.registered);
    const before = state.notifier.notifications.length;

    for (const listener of state.host.deleteListeners) {
      listener({ files: [uri("file:///workspace/api/src/value.ts")] });
    }
    await waitUntil(() => state.notifier.notifications.length > before);

    const deleted = state.notifier.notifications[before];
    expect(deleted).toEqual({
      method: "document/deleted",
      params: { workspaceId: "ws_events", uri: "file:///workspace/api/src/value.ts" },
    });
    expect(deleted?.params).not.toHaveProperty("document");
    expect(state.deletedUris).toEqual(["file:///workspace/api/src/value.ts"]);
    state.bridge.dispose();
  });

  it("expands a folder gesture onto the open documents beneath it", async () => {
    const state = fixture();
    await state.bridge.synchronize(state.notifier, state.registered);
    const before = state.notifier.notifications.length;

    // VS Code fires one event for the folder; only its open children can be named truthfully.
    for (const listener of state.host.deleteListeners) {
      listener({ files: [uri("file:///workspace/api/src")] });
    }
    await waitUntil(() => state.notifier.notifications.length > before);

    expect(state.notifier.notifications[before]).toMatchObject({
      method: "document/deleted",
      params: { uri: "file:///workspace/api/src/value.ts" },
    });
    state.bridge.dispose();
  });

  // The daemon starts a workspace at `initializing` and leaves it there until an adapter says
  // otherwise. This adapter never did, so a VS Code workspace read `initializing` for as long as it
  // was open — and a consumer polling for `ready` waited for a transition that was never coming.
  it("says the workspace is ready, since nothing else will", async () => {
    const state = fixture();

    await state.bridge.synchronize(state.notifier, state.registered);

    const methods = state.notifier.notifications.map((entry) => entry.method);
    expect(methods).toContain("workspace/readinessChanged");
    // Last, so a consumer acting on `ready` finds the open documents already announced.
    expect(methods.at(-1)).toBe("workspace/readinessChanged");
    expect(
      state.notifier.notifications.find((entry) => entry.method === "workspace/readinessChanged")
        ?.params,
    ).toMatchObject({
      status: { workspaceId: "ws_events", state: "ready", capabilitiesUnavailable: [] },
    });
    state.bridge.dispose();
  });

  it("announces a trust grant without disturbing anything else", async () => {
    const state = fixture();
    state.setUntrusted();
    await state.bridge.synchronize(state.notifier, state.registered);
    const before = state.notifier.notifications.length;

    state.grantTrust();
    for (const listener of state.host.trustListeners) listener();
    await waitUntil(() => state.notifier.notifications.length > before);

    expect(state.notifier.notifications[before]).toMatchObject({
      method: "workspace/trustChanged",
      params: { workspaceId: "ws_events", adapterId: "adapter_events", trust: "trusted" },
    });
    // No workspace/closed, no epoch bump: gaining trust invalidates nothing.
    expect(state.notifier.notifications.slice(before).map((entry) => entry.method)).toEqual([
      "workspace/trustChanged",
    ]);
    state.bridge.dispose();
  });

  // Every one of these five used to be a bare `return`. A notification that never leaves the
  // extension is indistinguishable, from the daemon's side, from a document that never changed —
  // which is precisely how a plan stayed valid across an edit that should have invalidated it.
  describe("names the reason an event is not sent", () => {
    // `synchronize` starts the listeners and sends its initial burst through the notifier it is
    // given, but does not remember it; only `setLiveNotifier` does. The extension always calls both,
    // so this exit should never fire in production — which is exactly why it needs to say so if it
    // ever does, rather than swallowing every event that follows.
    it("reports that no adapter session is live", async () => {
      const state = fixture({ live: false });
      await state.bridge.synchronize(state.notifier, state.registered);
      const before = state.notifier.notifications.length;

      for (const listener of state.host.openListeners) listener(state.document);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "no-notifier" }]);
      expect(state.notifier.notifications).toHaveLength(before);
      state.bridge.dispose();
    });

    it("reports that no workspace is projected", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      state.clearProjection();

      for (const listener of state.host.openListeners) listener(state.document);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "no-workspace" }]);
      state.bridge.dispose();
    });

    // Kept apart from `outside-workspace` deliberately. Every run drops the editor's chat input, so
    // sharing a name would mean a real file falling outside the roots — worth investigating — is
    // reported in the same words as the noise that is always there.
    it("reports a buffer the editor invented rather than a missing file", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);

      for (const listener of state.host.openListeners) listener(state.editorBuffer);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "unsupported-scheme" }]);
      state.bridge.dispose();
    });

    it("reports a document outside every workspace folder", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);

      for (const listener of state.host.openListeners) listener(state.outside);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "outside-workspace" }]);
      state.bridge.dispose();
    });

    it("reports a folder that is not a registered root", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      // The folder is open in the editor but absent from the workspace the daemon was told about.
      state.setFolders([{ name: "web", uri: uri("file:///workspace/web") }]);

      for (const listener of state.host.openListeners) listener(state.inWeb);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "no-matching-root" }]);
      state.bridge.dispose();
    });

    it("reports a document whose content cannot be read", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      state.breakMapping();

      for (const listener of state.host.openListeners) listener(state.document);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "unmappable" }]);
      state.bridge.dispose();
    });

    // The exit that was never in the list of five: `mapOpenDocument` succeeded, the notification was
    // formed and handed to the connection, and the send rejected. The old `catch(() => undefined)`
    // made this indistinguishable from an event that was never worth sending.
    it("reports a notification the connection refused", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      state.notifier.failNext("document/opened");

      for (const listener of state.host.openListeners) listener(state.document);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "send-failed" }]);
      state.bridge.dispose();
    });

    it("reports an event that arrives after the bridge is torn down", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      // Captured before the teardown, which unsubscribes them: VS Code can still be mid-dispatch
      // when the connection goes away, and that is the case this names.
      const listeners = [...state.host.openListeners];
      state.bridge.dispose();

      for (const listener of listeners) listener(state.document);
      await waitUntil(() => state.drops.length > 0);

      expect(state.drops).toEqual([{ method: "document/opened", reason: "disposed" }]);
    });

    it("says nothing when the event is sent", async () => {
      const state = fixture();
      await state.bridge.synchronize(state.notifier, state.registered);
      const before = state.notifier.notifications.length;

      for (const listener of state.host.openListeners) listener(state.document);
      await waitUntil(() => state.notifier.notifications.length > before);

      expect(state.drops).toEqual([]);
      state.bridge.dispose();
    });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for event bridge");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
