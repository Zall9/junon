/**
 * IDE Bridge VS Code Extension — extension entry point.
 *
 * Phase 3 extension-host entry point.
 * The manifest, authenticated lifecycle, workspace/revision foundations, and
 * safe document read surface are implemented incrementally.
 */

import * as vscode from "vscode";
import type { Workspace } from "@ide-bridge/protocol";

import { AdapterLifecycle } from "./adapter-lifecycle.js";
import { readAdapterConfiguration } from "./configuration.js";
import { VscodeDiagnosticRoutes } from "./diagnostic-routes.js";
import { ADAPTER_CAPABILITIES } from "./capabilities.js";
import { VscodeDocumentRoutes } from "./document-routes.js";
import { VscodeEditRoutes } from "./edit-routes.js";
import { VscodeEventBridge } from "./event-bridge.js";
import { createOpaqueIdentifier } from "./identifiers.js";
import { createSafeLifecycleLogger, type SafeLifecycleLogger } from "./safe-logger.js";
import { VscodeSymbolHandleRegistry } from "./symbol-mapper.js";
import { VscodeSymbolNavigationRoutes } from "./symbol-navigation-routes.js";
import { VscodeSymbolRoutes } from "./symbol-routes.js";
import { VscodeSymbolTargetResolver } from "./symbol-target.js";
import { createVscodeTopology } from "./topology.js";
import { VscodeWorkspaceModel } from "./workspace-model.js";

export const EXTENSION_ID = "ide-bridge.vscode-extension" as const;
export const EXTENSION_VERSION = "0.0.0" as const;

let activeLifecycle: AdapterLifecycle | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (activeLifecycle !== undefined) return;
  const channel = vscode.window.createOutputChannel("IDE Bridge", { log: true });
  outputChannel = channel;
  context.subscriptions.push(channel);

  let logger: SafeLifecycleLogger = createSafeLifecycleLogger(channel, "info");
  try {
    const configuration = readAdapterConfiguration(vscode.workspace.getConfiguration("ideBridge"));
    logger = createSafeLifecycleLogger(channel, configuration.logLevel);
    const adapterId = createOpaqueIdentifier("adapter_");
    const workspaceModel = new VscodeWorkspaceModel(adapterId);
    let projectedWorkspace: Workspace | undefined;
    const currentWorkspaces = () =>
      workspaceModel.snapshot(vscode.workspace.workspaceFolders, {
        ...(vscode.workspace.name === undefined ? {} : { name: vscode.workspace.name }),
        trusted: vscode.workspace.isTrusted,
      });
    const documentRoutes = new VscodeDocumentRoutes({
      host: {
        parseUri: (value) => vscode.Uri.parse(value, true),
        getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
        openTextDocument: async (uri) => await vscode.workspace.openTextDocument(uri as vscode.Uri),
        readFile: async (uri) =>
          new TextDecoder().decode(await vscode.workspace.fs.readFile(uri as vscode.Uri)),
      },
      workspaceModel,
      currentWorkspace: () => projectedWorkspace,
    });
    const handles = new VscodeSymbolHandleRegistry();
    const provideDocumentSymbols = async (uri: string): Promise<unknown> =>
      await vscode.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider",
        vscode.Uri.parse(uri, true),
      );
    const executeAtPosition = async (
      command: string,
      uri: string,
      position: { line: number; character: number },
    ): Promise<unknown> =>
      await vscode.commands.executeCommand(
        command,
        vscode.Uri.parse(uri, true),
        new vscode.Position(position.line, position.character),
      );
    const symbolRoutes = new VscodeSymbolRoutes({
      adapterId,
      documentRoutes,
      handles,
      provider: {
        provideDocumentSymbols,
        provideWorkspaceSymbols: async (query) =>
          await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query),
      },
      currentWorkspace: () => projectedWorkspace,
    });
    const navigationRoutes = new VscodeSymbolNavigationRoutes({
      adapterId,
      documentRoutes,
      handles,
      provider: {
        provideDocumentSymbols,
        provideDefinition: async (uri, position) =>
          await executeAtPosition("vscode.executeDefinitionProvider", uri, position),
        provideReferences: async (uri, position) =>
          await executeAtPosition("vscode.executeReferenceProvider", uri, position),
        provideImplementations: async (uri, position) =>
          await executeAtPosition("vscode.executeImplementationProvider", uri, position),
        provideHierarchy: async (uri, position, relation) => {
          // VS Code's hierarchies are two-phase: prepare an item at the position, then ask that
          // item for its neighbours. The protocol asks for one step, so both phases happen here
          // and a consumer never learns which of the two APIs answered.
          const callHierarchy = relation === "callers" || relation === "callees";
          const prepared = (await executeAtPosition(
            callHierarchy ? "vscode.prepareCallHierarchy" : "vscode.prepareTypeHierarchy",
            uri,
            position,
          )) as unknown[] | undefined;
          const item = prepared?.[0];
          // No item is an ordinary answer — the position is not a callable or a type — and is
          // reported as no neighbours rather than as a provider failure.
          if (item === undefined) return [];

          const command = {
            callers: "vscode.provideIncomingCalls",
            callees: "vscode.provideOutgoingCalls",
            supertypes: "vscode.provideSupertypes",
            subtypes: "vscode.provideSubtypes",
          }[relation];
          // The type travels as `executeCommand`'s argument rather than as an assertion on its
          // result: the command is typed `<T = unknown>`, so an assertion only ever supplied the
          // contextual type T was already inferred from — which is why it read as unnecessary.
          const neighbours = await vscode.commands.executeCommand<unknown[] | undefined>(
            command,
            item,
          );
          if (neighbours === undefined) return [];

          // A call hierarchy answers with wrappers carrying `from`/`to`; a type hierarchy answers
          // with items directly. Both are unwrapped to the item, whose `uri` and `selectionRange`
          // are what a location needs — the caller is the declaration, not the call site.
          return neighbours.map((entry) => {
            const wrapper = entry as { from?: unknown; to?: unknown };
            const target = (wrapper.from ?? wrapper.to ?? entry) as {
              uri: vscode.Uri;
              selectionRange: vscode.Range;
            };
            return new vscode.Location(target.uri, target.selectionRange);
          });
        },
      },
      currentWorkspace: () => projectedWorkspace,
    });
    const diagnosticRoutes = new VscodeDiagnosticRoutes({
      host: {
        allDiagnostics: () => vscode.languages.getDiagnostics(),
        diagnosticsFor: (uri) => vscode.languages.getDiagnostics(vscode.Uri.parse(uri, true)),
        openDocumentUris: () =>
          vscode.workspace.textDocuments.map((document) => document.uri.toString()),
        provideCodeActions: async (uri, range) => {
          const { start, end } = range as {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          return await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            vscode.Uri.parse(uri, true),
            new vscode.Range(start.line, start.character, end.line, end.character),
            vscode.CodeActionKind.QuickFix.value,
          );
        },
      },
      documentRoutes,
      currentWorkspace: () => projectedWorkspace,
    });
    const resolver = new VscodeSymbolTargetResolver({
      adapterId,
      documentRoutes,
      handles,
      provideDocumentSymbols,
    });
    const editRoutes = new VscodeEditRoutes({
      adapterId,
      documentRoutes,
      handles,
      resolver,
      currentWorkspace: () => projectedWorkspace,
      host: {
        provideFormatEdits: async (uri) => {
          // Computed, not applied: `executeFormatDocumentProvider` returns the edits without
          // touching the file, which is what lets preparing stay side-effect free.
          const parsed = vscode.Uri.parse(uri, true);
          const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
            "vscode.executeFormatDocumentProvider",
            parsed,
          );
          if (edits === undefined || edits.length === 0) return undefined;
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.set(parsed, edits);
          return workspaceEdit;
        },
        provideCodeActions: async (uri, range) => {
          const { start, end } = range as {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          return await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            vscode.Uri.parse(uri, true),
            new vscode.Range(start.line, start.character, end.line, end.character),
            vscode.CodeActionKind.QuickFix.value,
          );
        },
        prepareRename: async (uri, position) =>
          await executeAtPosition("vscode.prepareRename", uri, position),
        provideRenameEdits: async (uri, position, newName) =>
          await vscode.commands.executeCommand(
            "vscode.executeDocumentRenameProvider",
            vscode.Uri.parse(uri, true),
            new vscode.Position(position.line, position.character),
            newName,
          ),
        describeEdit: (edit) =>
          (edit as vscode.WorkspaceEdit)
            .entries()
            .map(([uri, edits]) => [uri.toString(), edits.length] as const),
        applyEdit: async (edit) =>
          await vscode.workspace.applyEdit(edit as vscode.WorkspaceEdit, {
            isRefactoring: true,
          }),
        save: async (uri) => {
          const document = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === uri,
          );
          return document === undefined ? false : await document.save();
        },
      },
    });
    const invalidateForUri = (uri: string): void => {
      const workspace = projectedWorkspace;
      if (workspace !== undefined) symbolRoutes.invalidateDocument(workspace.workspaceId, uri);
      editRoutes.invalidateDocument(uri);
    };
    const eventBridge = new VscodeEventBridge({
      host: {
        get textDocuments() {
          return vscode.workspace.textDocuments;
        },
        onDidOpenTextDocument: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
        onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
        onDidSaveTextDocument: (listener) => vscode.workspace.onDidSaveTextDocument(listener),
        onDidCloseTextDocument: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
        onDidChangeWorkspaceFolders: (listener) =>
          vscode.workspace.onDidChangeWorkspaceFolders(listener),
        onDidChangeDiagnostics: (listener) => vscode.languages.onDidChangeDiagnostics(listener),
        onDidRenameFiles: (listener) => vscode.workspace.onDidRenameFiles(listener),
        onDidDeleteFiles: (listener) => vscode.workspace.onDidDeleteFiles(listener),
        onDidGrantWorkspaceTrust: (listener) => vscode.workspace.onDidGrantWorkspaceTrust(listener),
      },
      documentRoutes,
      currentWorkspaces,
      documentChanged: (uri) => {
        const workspace = projectedWorkspace;
        if (workspace !== undefined) {
          symbolRoutes.invalidateDocument(workspace.workspaceId, uri);
        }
        // A prepared plan's preconditions cannot survive a change to a document it covers.
        editRoutes.invalidateDocument(uri);
      },
      documentRenamed: (previousUri, currentUri) => {
        invalidateForUri(previousUri);
        invalidateForUri(currentUri);
      },
      documentDeleted: (uri) => {
        invalidateForUri(uri);
      },
      workspaceProjectionChanged: (workspace) => {
        if (
          projectedWorkspace?.workspaceId !== workspace?.workspaceId ||
          projectedWorkspace?.workspaceEpoch !== workspace?.workspaceEpoch
        ) {
          symbolRoutes.invalidateAll();
          editRoutes.invalidateAll();
        }
        projectedWorkspace = workspace;
      },
      // A dropped notification is the daemon's blind spot: it cannot invalidate a plan against an
      // edit it never heard about. Debug level, because a healthy session drops nothing.
      documentEventDropped: (method, reason) => {
        logger.debug(`dropped ${method} (${reason})`);
      },
    });
    const topology = createVscodeTopology({
      appHost: vscode.env.appHost,
      ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
      ...(vscode.workspace.workspaceFolders === undefined
        ? {}
        : { workspaceFolders: vscode.workspace.workspaceFolders }),
    });
    // Disk changes made outside the editor emit no VS Code document event, so handles and plans
    // for closed files would otherwise stay live against content that already moved (ADR-0022).
    // This watcher only invalidates; it never synthesises a rename it cannot observe.
    const externalChanges = vscode.workspace.createFileSystemWatcher("**/*");
    const onExternalChange = (uri: vscode.Uri): void => {
      invalidateForUri(uri.toString());
    };
    context.subscriptions.push(
      externalChanges,
      externalChanges.onDidChange(onExternalChange),
      externalChanges.onDidDelete(onExternalChange),
      externalChanges.onDidCreate(onExternalChange),
    );

    const lifecycle = new AdapterLifecycle({
      configuration,
      topology,
      daemonScriptPath: context.asAbsolutePath("dist/daemon-child.js"),
      logger,
      configureConnection: (connection) => {
        eventBridge.setLiveNotifier(connection);
        const disposeDocumentRoutes = documentRoutes.attach(connection);
        const disposeSymbolRoutes = symbolRoutes.attach(connection);
        const disposeNavigationRoutes = navigationRoutes.attach(connection);
        const disposeDiagnosticRoutes = diagnosticRoutes.attach(connection);
        const disposeEditRoutes = editRoutes.attach(connection);
        return () => {
          disposeEditRoutes();
          disposeDiagnosticRoutes();
          disposeNavigationRoutes();
          disposeSymbolRoutes();
          disposeDocumentRoutes();
          symbolRoutes.invalidateAll();
          editRoutes.invalidateAll();
          eventBridge.dispose();
        };
      },
      registrationCompleted: async (connection, _reason, registration) => {
        await eventBridge.synchronize(connection, registration.workspaces);
      },

      registration: (reason) => {
        if (reason === "reconnect") {
          workspaceModel.invalidateSemanticState();
          symbolRoutes.invalidateAll();
        }
        const workspaces = currentWorkspaces();
        projectedWorkspace = workspaces[0];
        return {
          adapterId,
          name: "IDE Bridge for VS Code",
          version: EXTENSION_VERSION,
          ideKind: "vscode",
          ideVersion: vscode.version,
          positionEncodings: ["utf-16"],
          capabilities: ADAPTER_CAPABILITIES,
          workspaces,
        };
      },
    });
    activeLifecycle = lifecycle;
    await lifecycle.start();
  } catch {
    logger.error("activation-failed");
  }
}

export async function deactivate(): Promise<void> {
  const lifecycle = activeLifecycle;
  activeLifecycle = undefined;
  await lifecycle?.stop();
  outputChannel?.dispose();
  outputChannel = undefined;
}
