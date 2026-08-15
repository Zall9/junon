import {
  BridgeAdapterRequestError,
  MAX_CLIENT_MESSAGE_BYTES,
  type ReconnectingBridgeConnection,
} from "@ide-bridge/bridge-client";
import { IDEBP_MAX_DIAGNOSTIC_DOCUMENTS, isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
import type {
  Diagnostic,
  DocumentContent,
  DocumentDiagnostics,
  JSONRPCRequestIdentifier,
  Workspace,
} from "@ide-bridge/protocol";

import {
  MAX_DIAGNOSTICS_WITH_FIXES,
  mapCodeActions,
  mapVscodeDiagnostics,
} from "./diagnostic-mapper.js";
import type { VscodeDocumentRoutes } from "./document-routes.js";

export interface VscodeDiagnosticHost {
  /** All resources VS Code currently reports diagnostics for, open or not. */
  allDiagnostics(): readonly (readonly [{ toString(): string }, unknown])[];
  diagnosticsFor(uri: string): unknown;
  /**
   * `vscode.executeCodeActionProvider` for one diagnostic's range.
   *
   * Separate from reading diagnostics because VS Code computes fixes on demand: unlike IntelliJ,
   * where they hang off the highlight already, each one costs a provider round trip.
   */
  provideCodeActions(uri: string, range: unknown): Promise<unknown>;
  /** URIs of the text documents the editor currently holds open. */
  openDocumentUris(): readonly string[];
}

export interface VscodeDiagnosticRoutesOptions {
  host: VscodeDiagnosticHost;
  documentRoutes: VscodeDocumentRoutes;
  currentWorkspace(): Workspace | undefined;
  now?: () => Date;
}

type AdapterRouteConnection = Pick<ReconnectingBridgeConnection, "onRequest">;

export class VscodeDiagnosticRoutes {
  readonly #options: VscodeDiagnosticRoutesOptions;
  readonly #now: () => Date;

  constructor(options: VscodeDiagnosticRoutesOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  attach(connection: AdapterRouteConnection): () => void {
    return connection.onRequest("diagnostics/getSnapshot", async (params, context) => {
      const workspace = this.#assertWorkspace(params.workspaceId);
      const isWithinWorkspace = (uri: string): boolean =>
        workspace.roots.some((root) => isUriWithinWorkspaceRoot(uri, root.uri));

      const requested = params.documentUris;
      if (requested !== undefined) {
        for (const uri of requested) {
          // Fail the whole request rather than quietly returning fewer documents than asked for:
          // an out-of-scope URI is a scope error, not a partial result.
          if (!isWithinWorkspace(uri)) throw requestError("PERMISSION_DENIED");
        }
      }

      // Closed documents are included: their revision comes from disk and simply carries no
      // editorVersion (ADR-0020). Nothing is opened, so no document event is emitted.
      const scope =
        requested === undefined
          ? this.#options.host
              .allDiagnostics()
              .map(([uri]) => uri.toString())
              .filter((uri) => isWithinWorkspace(uri))
          : [...requested];
      let truncated = false;

      const documents: DocumentDiagnostics[] = [];
      for (const uri of scope) {
        assertNotCancelled(context.signal);
        if (documents.length >= IDEBP_MAX_DIAGNOSTIC_DOCUMENTS) {
          truncated = true;
          break;
        }
        const entry = await this.#documentDiagnostics(
          params.workspaceId,
          uri,
          context.signal,
          // Fixes are fetched only when the consumer named the documents. A project-wide sweep
          // would cost one provider round trip per diagnostic, which is how a request runs into
          // the daemon's route timeout — and a snapshot that never arrives is worth less than one
          // without offers.
          requested !== undefined,
        );
        if (entry === undefined) {
          truncated = true;
          continue;
        }
        if (entry.truncated) truncated = true;
        documents.push(entry.document);
      }

      return fitSnapshot(context.id, documents, truncated, this.#now().toISOString());
    });
  }

  async #documentDiagnostics(
    workspaceId: Workspace["workspaceId"],
    uri: string,
    signal: AbortSignal,
    withFixes: boolean,
  ): Promise<{ document: DocumentDiagnostics; truncated: boolean } | undefined> {
    // An open document gives an exact in-memory revision; anything else is read from disk without
    // creating a buffer. Only a document the editor already holds is read through the open path.
    let content = this.#options.host.openDocumentUris().includes(uri)
      ? await this.#readOpenDocument(workspaceId, uri, signal)
      : undefined;
    content ??= await this.#options.documentRoutes.readFromDisk(uri, signal);
    if (content === undefined) return undefined;
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined) return undefined;
    const isWithinWorkspace = (candidate: string): boolean =>
      workspace.roots.some((root) => isUriWithinWorkspaceRoot(candidate, root.uri));

    let mapping;
    try {
      mapping = mapVscodeDiagnostics(this.#options.host.diagnosticsFor(uri), isWithinWorkspace);
    } catch {
      return undefined;
    }
    const diagnostics = withFixes
      ? await this.#withAvailableFixes(uri, mapping.diagnostics, signal)
      : mapping.diagnostics;
    return {
      document: { document: content.document, diagnostics },
      truncated: mapping.truncated,
    };
  }

  /**
   * Attaches the fixes the IDE offers, for a bounded prefix of the diagnostics.
   *
   * Capped rather than exhaustive: each entry is a provider round trip, and a document with
   * hundreds of problems would spend the request budget fetching offers nobody asked to see. The
   * diagnostics past the cap keep their `availableFixes` absent, which already means "not looked
   * at" rather than "none offered".
   */
  async #withAvailableFixes(
    uri: string,
    diagnostics: readonly Diagnostic[],
    signal: AbortSignal,
  ): Promise<Diagnostic[]> {
    const result: Diagnostic[] = [];
    for (const [index, diagnostic] of diagnostics.entries()) {
      assertNotCancelled(signal);
      if (index >= MAX_DIAGNOSTICS_WITH_FIXES) {
        result.push(diagnostic);
        continue;
      }
      let actions: unknown;
      try {
        actions = await this.#options.host.provideCodeActions(uri, diagnostic.range);
      } catch {
        // A provider that throws is not a reason to lose the diagnostic itself, which is the more
        // important half of the answer.
        result.push(diagnostic);
        continue;
      }
      const fixes = mapCodeActions(actions);
      result.push(fixes.length === 0 ? diagnostic : { ...diagnostic, availableFixes: fixes });
    }
    return result;
  }

  async #readOpenDocument(
    workspaceId: Workspace["workspaceId"],
    uri: string,
    signal: AbortSignal,
  ): Promise<DocumentContent | undefined> {
    try {
      return await this.#options.documentRoutes.read({ workspaceId, uri }, signal);
    } catch (error) {
      if (error instanceof BridgeAdapterRequestError && error.data.code === "CANCELLED")
        throw error;
      return undefined;
    }
  }

  #assertWorkspace(workspaceId: Workspace["workspaceId"]): Workspace {
    const workspace = this.#options.currentWorkspace();
    if (workspace === undefined || workspace.workspaceId !== workspaceId) {
      throw new BridgeAdapterRequestError({
        code: "WORKSPACE_NOT_FOUND",
        retryable: false,
        details: { workspaceId },
      });
    }
    return workspace;
  }
}

/**
 * Drops whole documents until the response fits the frame ceiling, reporting the loss through
 * `truncated`. Diagnostic messages are never clipped: altering the text of a diagnostic would
 * silently misreport what the language service actually said.
 */
function fitSnapshot(
  id: JSONRPCRequestIdentifier,
  documents: DocumentDiagnostics[],
  incomplete: boolean,
  capturedAt: string,
): { documents: DocumentDiagnostics[]; capturedAt: string; truncated: boolean } {
  let kept = documents;
  let truncated = incomplete;
  while (kept.length > 0 && !responseFits(id, { documents: kept, capturedAt, truncated: false })) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    truncated = true;
  }
  return { documents: kept, capturedAt, truncated };
}

function responseFits(id: JSONRPCRequestIdentifier, result: object): boolean {
  return (
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8") <=
    MAX_CLIENT_MESSAGE_BYTES
  );
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw requestError("CANCELLED");
}

function requestError(code: "CANCELLED" | "PERMISSION_DENIED"): BridgeAdapterRequestError {
  return new BridgeAdapterRequestError({ code, retryable: false });
}
