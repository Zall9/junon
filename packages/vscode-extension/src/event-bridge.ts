import type {
  IDEBPNotificationMethod,
  IDEBPNotificationParams,
  Workspace,
} from "@ide-bridge/protocol";

import type { VscodeTextDocumentLike } from "./document-mapper.js";
import type { MapDocumentSkip, VscodeDocumentRoutes } from "./document-routes.js";

const DOCUMENT_CHANGE_DEBOUNCE_MS = 75;
const MAX_DEBOUNCED_DOCUMENTS = 1_024;
/** One diagnostics event can name many resources; a burst must not become unbounded work. */
const MAX_DIAGNOSTIC_EVENT_URIS = 1_024;
/** One file gesture can name many files; a bulk operation must not become unbounded work. */
const MAX_FILE_EVENT_ENTRIES = 1_024;

export interface AdapterNotifier {
  notify<M extends IDEBPNotificationMethod>(
    method: M,
    params: IDEBPNotificationParams<M>,
  ): Promise<void>;
}

export interface VscodeDisposableLike {
  dispose(): unknown;
}

export interface VscodeDocumentChangeEventLike {
  readonly document: VscodeTextDocumentLike;
}

export interface VscodeEventHost {
  readonly textDocuments: readonly VscodeTextDocumentLike[];
  onDidOpenTextDocument(
    listener: (document: VscodeTextDocumentLike) => unknown,
  ): VscodeDisposableLike;
  onDidChangeTextDocument(
    listener: (event: VscodeDocumentChangeEventLike) => unknown,
  ): VscodeDisposableLike;
  onDidSaveTextDocument(
    listener: (document: VscodeTextDocumentLike) => unknown,
  ): VscodeDisposableLike;
  onDidCloseTextDocument(
    listener: (document: VscodeTextDocumentLike) => unknown,
  ): VscodeDisposableLike;
  onDidChangeWorkspaceFolders(listener: () => unknown): VscodeDisposableLike;
  onDidChangeDiagnostics?(
    listener: (event: { readonly uris: readonly { toString(): string }[] }) => unknown,
  ): VscodeDisposableLike;
  onDidRenameFiles?(
    listener: (event: {
      readonly files: readonly {
        readonly oldUri: { toString(): string };
        readonly newUri: { toString(): string };
      }[];
    }) => unknown,
  ): VscodeDisposableLike;
  onDidDeleteFiles?(
    listener: (event: { readonly files: readonly { toString(): string }[] }) => unknown,
  ): VscodeDisposableLike;
  /** Fires when the user grants trust. VS Code cannot revoke trust without a window reload. */
  onDidGrantWorkspaceTrust?(listener: () => unknown): VscodeDisposableLike;
}

export interface VscodeEventBridgeOptions {
  host: VscodeEventHost;
  documentRoutes: VscodeDocumentRoutes;
  currentWorkspaces(): [] | [Workspace];
  documentChanged?(uri: string): void;
  documentRenamed?(previousUri: string, currentUri: string): void;
  documentDeleted?(uri: string): void;
  workspaceProjectionChanged?(workspace: Workspace | undefined): void;
  /** An event that will never reach the daemon, and the reason it stopped here. */
  documentEventDropped?(method: DroppableNotificationMethod, reason: DocumentEventDropReason): void;
}

/**
 * Why a document event was not sent.
 *
 * Three are decided by the bridge — no adapter session is live, the bridge was torn down, or the
 * send itself failed — and four by `mapOpenDocument`, which used to answer all of them with a bare
 * `undefined`.
 */
export type DocumentEventDropReason = MapDocumentSkip | "disposed" | "no-notifier" | "send-failed";

/** The notifications that can be dropped before they are sent. */
export type DroppableNotificationMethod =
  | "diagnostics/changed"
  | "document/changed"
  | "document/closed"
  | "document/opened"
  | "document/renamed"
  | "document/saved";

export class VscodeEventBridge {
  readonly #options: VscodeEventBridgeOptions;
  readonly #disposables: VscodeDisposableLike[] = [];
  readonly #pendingChanges = new Map<
    string,
    { document: VscodeTextDocumentLike; timer: ReturnType<typeof setTimeout> }
  >();
  readonly #pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();
  #liveNotifier: AdapterNotifier | undefined;
  #announcedWorkspace: Workspace | undefined;
  #tail = Promise.resolve();
  #started = false;
  #disposed = false;

  constructor(options: VscodeEventBridgeOptions) {
    this.#options = options;
  }

  setLiveNotifier(notifier: AdapterNotifier): void {
    if (this.#liveNotifier !== undefined) throw new Error("Live notifier is already configured");
    this.#liveNotifier = notifier;
  }

  async synchronize(
    notifier: AdapterNotifier,
    registeredWorkspaces: readonly Workspace[],
  ): Promise<void> {
    if (this.#disposed) return;
    this.#startListeners();
    await this.#serialize(async () => {
      this.#setAnnouncedWorkspace(cloneSingleWorkspace(registeredWorkspaces));
      await this.#reconcileWorkspace(notifier);
      let processed = 0;
      for (const document of this.#options.host.textDocuments) {
        await this.#notifyDocument(notifier, "document/opened", document);
        processed += 1;
        if (processed % 16 === 0) await yieldToExtensionHost();
      }
      // Last, and here rather than in `reconcileWorkspace`: on the ordinary path the daemon already
      // learned of this workspace from `ide/register`, so reconciliation has nothing to say and the
      // readiness would never be sent at all — which is what left every VS Code workspace reading
      // `initializing` for as long as it was open. Saying it after the projection means a consumer
      // that acts on `ready` finds the open documents already announced.
      const registered = this.#announcedWorkspace;
      if (registered !== undefined) await this.#announceReadiness(notifier, registered);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pendingChanges.values()) clearTimeout(pending.timer);
    this.#pendingChanges.clear();
    for (const timer of this.#pendingDiagnostics.values()) clearTimeout(timer);
    this.#pendingDiagnostics.clear();
    for (const disposable of this.#disposables.splice(0)) disposable.dispose();
  }

  #startListeners(): void {
    if (this.#started) return;
    this.#started = true;
    const host = this.#options.host;
    this.#disposables.push(
      host.onDidOpenTextDocument((document) => {
        this.#queueDocument("document/opened", document);
      }),
      host.onDidChangeTextDocument(({ document }) => {
        this.#options.documentChanged?.(document.uri.toString());
        this.#debounceDocumentChange(document);
      }),
      host.onDidSaveTextDocument((document) => {
        this.#flushPendingChange(document.uri.toString());
        this.#queueDocument("document/saved", document);
      }),
      host.onDidCloseTextDocument((document) => {
        this.#flushPendingChange(document.uri.toString());
        this.#queueDocument("document/closed", document);
      }),
      host.onDidChangeWorkspaceFolders(() => {
        const notifier = this.#liveNotifier;
        if (notifier !== undefined) {
          void this.#serialize(async () => this.#reconcileWorkspace(notifier)).catch(
            () => undefined,
          );
        }
      }),
    );
    const onRename = host.onDidRenameFiles?.bind(host);
    if (onRename !== undefined) {
      this.#disposables.push(
        onRename(({ files }) => {
          for (const { oldUri, newUri } of files.slice(0, MAX_FILE_EVENT_ENTRIES)) {
            this.#queueRename(oldUri.toString(), newUri.toString());
          }
        }),
      );
    }
    const onDelete = host.onDidDeleteFiles?.bind(host);
    if (onDelete !== undefined) {
      this.#disposables.push(
        onDelete(({ files }) => {
          for (const uri of files.slice(0, MAX_FILE_EVENT_ENTRIES)) {
            this.#queueDelete(uri.toString());
          }
        }),
      );
    }
    const onTrust = host.onDidGrantWorkspaceTrust?.bind(host);
    if (onTrust !== undefined) {
      this.#disposables.push(
        onTrust(() => {
          this.#queueTrustChange();
        }),
      );
    }
    const onDiagnostics = host.onDidChangeDiagnostics?.bind(host);
    if (onDiagnostics !== undefined) {
      this.#disposables.push(
        onDiagnostics(({ uris }) => {
          for (const uri of uris.slice(0, MAX_DIAGNOSTIC_EVENT_URIS)) {
            this.#debounceDiagnosticsChange(uri.toString());
          }
        }),
      );
    }
  }

  /**
   * A diagnostics change is announced only for a document the editor holds open. The notification
   * requires a revision, and a closed document has no editor version to report truthfully
   * (ADR-0019). Changes are debounced per URI because language services re-publish diagnostics
   * repeatedly while typing.
   */
  #debounceDiagnosticsChange(uri: string): void {
    if (this.#disposed || this.#liveNotifier === undefined) return;
    const previous = this.#pendingDiagnostics.get(uri);
    if (previous !== undefined) clearTimeout(previous);
    if (previous === undefined && this.#pendingDiagnostics.size >= MAX_DEBOUNCED_DOCUMENTS) return;
    const timer = setTimeout(() => {
      if (this.#pendingDiagnostics.get(uri) !== timer) return;
      this.#pendingDiagnostics.delete(uri);
      this.#queueDiagnostics(uri);
    }, DOCUMENT_CHANGE_DEBOUNCE_MS);
    timer.unref();
    this.#pendingDiagnostics.set(uri, timer);
  }

  /**
   * VS Code reports one event per user gesture, and a folder gesture names only the folder. The
   * bridge therefore projects a rename onto the folder's own URI when it names a document, and
   * onto every open document beneath it otherwise — the only children it can identify truthfully
   * (ADR-0022). Files renamed outside the editor produce no event at all.
   */
  #queueRename(previousUri: string, currentUri: string): void {
    const notifier = this.#liveNotifier;
    if (notifier === undefined || this.#disposed) return;
    void this.#serialize(async () => {
      if (this.#disposed) return;
      for (const [oldUri, newUri] of this.#expandFileGesture(previousUri, currentUri)) {
        const document = this.#options.host.textDocuments.find(
          (candidate) => candidate.uri.toString() === newUri,
        );
        if (document === undefined) continue;
        const outcome = await this.#options.documentRoutes.mapOpenDocument(document);
        if (outcome.content === undefined) {
          this.#dropped("document/renamed", outcome.skipped);
          continue;
        }
        const mapped = outcome.content;
        this.#options.documentRenamed?.(oldUri, newUri);
        await notifier.notify("document/renamed", {
          workspaceId: mapped.document.workspaceId,
          previousUri: oldUri,
          document: mapped.document,
        });
      }
    }).catch(() => undefined);
  }

  #queueDelete(uri: string): void {
    const notifier = this.#liveNotifier;
    if (notifier === undefined || this.#disposed) return;
    void this.#serialize(async () => {
      if (this.#disposed) return;
      const workspace = this.#announcedWorkspace;
      if (workspace === undefined) return;
      for (const deleted of this.#expandDeletion(uri)) {
        this.#options.documentDeleted?.(deleted);
        // A deleted document has no revision to report: the file is gone (ADR-0022).
        await notifier.notify("document/deleted", {
          workspaceId: workspace.workspaceId,
          uri: deleted,
        });
      }
    }).catch(() => undefined);
  }

  #queueTrustChange(): void {
    const notifier = this.#liveNotifier;
    if (notifier === undefined || this.#disposed) return;
    void this.#serialize(async () => {
      if (this.#disposed) return;
      const workspace = this.#options.currentWorkspaces()[0];
      if (workspace === undefined) return;
      this.#setAnnouncedWorkspace(workspace);
      await notifier.notify("workspace/trustChanged", {
        workspaceId: workspace.workspaceId,
        adapterId: workspace.adapterId,
        trust: workspace.trust,
      });
    }).catch(() => undefined);
  }

  /** Maps a rename gesture to the documents it actually moved that the editor can identify. */
  #expandFileGesture(previousUri: string, currentUri: string): [string, string][] {
    const directPrefix = `${currentUri}/`;
    const affected = this.#options.host.textDocuments
      .map((document) => document.uri.toString())
      .filter((uri) => uri.startsWith(directPrefix));
    if (affected.length === 0) return [[previousUri, currentUri]];
    return affected.map((uri) => [`${previousUri}${uri.slice(currentUri.length)}`, uri]);
  }

  #expandDeletion(uri: string): string[] {
    const prefix = `${uri}/`;
    const affected = this.#options.host.textDocuments
      .map((document) => document.uri.toString())
      .filter((candidate) => candidate.startsWith(prefix));
    return affected.length === 0 ? [uri] : affected;
  }

  #queueDiagnostics(uri: string): void {
    const notifier = this.#liveNotifier;
    if (notifier === undefined || this.#disposed) return;
    void this.#serialize(async () => {
      if (this.#disposed) return;
      const document = this.#options.host.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri,
      );
      if (document === undefined) return;
      const outcome = await this.#options.documentRoutes.mapOpenDocument(document);
      if (outcome.content === undefined) {
        this.#dropped("diagnostics/changed", outcome.skipped);
        return;
      }
      const mapped = outcome.content;
      await notifier.notify("diagnostics/changed", {
        workspaceId: mapped.document.workspaceId,
        documentUri: mapped.document.uri,
        revision: mapped.document.revision,
      });
    }).catch(() => undefined);
  }

  #debounceDocumentChange(document: VscodeTextDocumentLike): void {
    const uri = document.uri.toString();
    const previous = this.#pendingChanges.get(uri);
    if (previous !== undefined) clearTimeout(previous.timer);
    if (previous === undefined && this.#pendingChanges.size >= MAX_DEBOUNCED_DOCUMENTS) {
      this.#queueDocument("document/changed", document);
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.#pendingChanges.get(uri);
      if (pending?.timer !== timer) return;
      this.#pendingChanges.delete(uri);
      this.#queueDocument("document/changed", pending.document);
    }, DOCUMENT_CHANGE_DEBOUNCE_MS);
    timer.unref();
    this.#pendingChanges.set(uri, { document, timer });
  }

  #flushPendingChange(uri: string): void {
    const pending = this.#pendingChanges.get(uri);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingChanges.delete(uri);
    this.#queueDocument("document/changed", pending.document);
  }

  /**
   * An event the daemon will never hear about, and why.
   *
   * Every exit that used to be a bare `return` — or a `catch` that swallowed the failure — reports
   * here instead. Seven of them, where five were counted: the two nobody listed were a failed send
   * and teardown.
   *
   * They were added while hunting a plan that an edit failed to invalidate, and they did not find
   * it — the suite was talking to the wrong daemon (ADR-0037). They stay because the hunt would
   * have been shorter with them: "no notification was dropped" is an answer, and there was none.
   *
   * `disposed` names a drop that is correct rather than defective; it is still named, because a
   * category that only contains defects cannot tell you that nothing went wrong.
   */
  #dropped(method: DroppableNotificationMethod, reason: DocumentEventDropReason): void {
    this.#options.documentEventDropped?.(method, reason);
  }

  #queueDocument(
    method: "document/opened" | "document/changed" | "document/saved" | "document/closed",
    document: VscodeTextDocumentLike,
  ): void {
    if (this.#disposed) {
      this.#dropped(method, "disposed");
      return;
    }
    const notifier = this.#liveNotifier;
    if (notifier === undefined) {
      this.#dropped(method, "no-notifier");
      return;
    }
    void this.#serialize(async () => this.#notifyDocument(notifier, method, document)).catch(() => {
      // The send itself failed. This was the swallow nobody counted when the five exits above
      // were enumerated, and it is the only one that can lose an event the mapping accepted.
      this.#dropped(method, "send-failed");
    });
  }

  async #notifyDocument(
    notifier: AdapterNotifier,
    method: "document/opened" | "document/changed" | "document/saved" | "document/closed",
    document: VscodeTextDocumentLike,
  ): Promise<void> {
    if (this.#disposed) {
      this.#dropped(method, "disposed");
      return;
    }
    const outcome = await this.#options.documentRoutes.mapOpenDocument(document);
    if (outcome.content === undefined) {
      this.#dropped(method, outcome.skipped);
      return;
    }
    await notifier.notify(method, { document: outcome.content.document });
  }

  /**
   * Says this workspace can be served.
   *
   * The daemon starts every workspace at `initializing` and leaves it there until an adapter says
   * otherwise — and this one never did, so a VS Code workspace read `initializing` for as long as it
   * was open. A consumer polling for `ready` waited for a transition that was never coming, and
   * `ide_status` reported "the project is still opening" about an editor that had been ready for
   * hours.
   *
   * The state is always `ready`, and that is not a simplification: VS Code exposes no index-readiness
   * signal, so this adapter has never reported `indexing` and does not pretend to (ADR-0019). Nor
   * does it report `degraded` — the JetBrains adapter detects that with a background probe, and an
   * extension host has one thread: if it were blocked, nothing here would run to notice. What
   * happens instead is that its heartbeat stops and the daemon expires the session, which is a
   * truthful signal rather than a manufactured one.
   */
  async #announceReadiness(notifier: AdapterNotifier, workspace: Workspace): Promise<void> {
    await notifier.notify("workspace/readinessChanged", {
      status: {
        workspaceId: workspace.workspaceId,
        state: "ready",
        capabilitiesUnavailable: [],
        progress: { known: false },
      },
    });
  }

  async #reconcileWorkspace(notifier: AdapterNotifier): Promise<void> {
    const current = this.#options.currentWorkspaces()[0];
    const announced = this.#announcedWorkspace;
    if (announced === undefined && current === undefined) return;
    if (announced === undefined && current !== undefined) {
      await notifier.notify("workspace/opened", { workspace: current });
      await this.#announceReadiness(notifier, current);
      this.#setAnnouncedWorkspace(current);
      return;
    }
    if (announced !== undefined && current === undefined) {
      await notifier.notify("workspace/closed", {
        workspaceId: announced.workspaceId,
        adapterId: announced.adapterId,
      });
      this.#setAnnouncedWorkspace(undefined);
      return;
    }
    if (announced === undefined || current === undefined) return;
    if (
      announced.workspaceId !== current.workspaceId ||
      announced.adapterId !== current.adapterId
    ) {
      throw new Error("Workspace identity changed during one adapter lifecycle");
    }

    if (!sameRoots(announced, current) || announced.workspaceEpoch !== current.workspaceEpoch) {
      await notifier.notify("workspace/rootsChanged", {
        workspaceId: current.workspaceId,
        adapterId: current.adapterId,
        roots: current.roots,
        workspaceEpoch: current.workspaceEpoch,
      });
      this.#setAnnouncedWorkspace({
        ...structuredClone(announced),
        roots: structuredClone(current.roots),
        workspaceEpoch: current.workspaceEpoch,
      });
      return;
    }
    if (announced.trust === current.trust) this.#setAnnouncedWorkspace(current);
  }

  #setAnnouncedWorkspace(workspace: Workspace | undefined): void {
    this.#announcedWorkspace = workspace === undefined ? undefined : structuredClone(workspace);
    this.#options.workspaceProjectionChanged?.(
      workspace === undefined ? undefined : structuredClone(workspace),
    );
  }

  #serialize(task: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

function cloneSingleWorkspace(workspaces: readonly Workspace[]): Workspace | undefined {
  if (workspaces.length > 1) throw new Error("VS Code may register at most one IDEBP workspace");
  return workspaces[0] === undefined ? undefined : structuredClone(workspaces[0]);
}

function sameRoots(left: Workspace, right: Workspace): boolean {
  return (
    left.roots.length === right.roots.length &&
    left.roots.every((root, index) => {
      const candidate = right.roots[index];
      return (
        candidate !== undefined &&
        root.rootId === candidate.rootId &&
        root.name === candidate.name &&
        root.uri === candidate.uri
      );
    })
  );
}

async function yieldToExtensionHost(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
