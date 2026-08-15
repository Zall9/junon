import { createHash, webcrypto } from "node:crypto";
import { posix } from "node:path";

import type {
  DocumentContent,
  DocumentReference,
  Workspace,
  WorkspaceRoot,
} from "@ide-bridge/protocol";

export interface VscodeDocumentUriLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  toString(): string;
}

export interface VscodeTextDocumentLike {
  readonly uri: VscodeDocumentUriLike;
  readonly version: number;
  readonly languageId: string;
  readonly isDirty: boolean;
  getText(): string;
}

export interface DocumentMappingContext {
  workspace: Workspace;
  root: WorkspaceRoot;
  rootUri: VscodeDocumentUriLike;
}

export function hashInMemoryContent(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export async function hashInMemoryContentAsync(text: string): Promise<`sha256:${string}`> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

export function mapTextDocument(
  document: VscodeTextDocumentLike,
  context: DocumentMappingContext,
): DocumentContent {
  const snapshot = captureDocument(document, context);
  return {
    document: createDocumentReference(snapshot, hashInMemoryContent(snapshot.text)),
    text: snapshot.text,
  };
}

/**
 * Maps file content read from disk, for a document no editor holds open.
 *
 * The resulting revision carries no `editorVersion`: a file on disk has no editor buffer, and
 * fabricating a number would claim editor state that does not exist. `contentHash` is the
 * authoritative identity in both cases (ADR-0002, amended by ADR-0020).
 *
 * Nothing here opens a `TextDocument`. VS Code documents that says of `openTextDocument`: the
 * lifecycle belongs to the editor, and a close can occur at any time — so a version obtained that
 * way would not survive a prepare/apply window anyway.
 */
export async function mapDiskDocumentAsync(
  uri: VscodeDocumentUriLike,
  text: string,
  context: DocumentMappingContext,
): Promise<DocumentContent> {
  const snapshot = captureDiskDocument(uri, text, context);
  const contentHash = await hashInMemoryContentAsync(snapshot.text);
  return { document: createDocumentReference(snapshot, contentHash), text: snapshot.text };
}

export async function mapTextDocumentAsync(
  document: VscodeTextDocumentLike,
  context: DocumentMappingContext,
): Promise<DocumentContent> {
  const snapshot = captureDocument(document, context);
  const contentHash = await hashInMemoryContentAsync(snapshot.text);
  return {
    document: createDocumentReference(snapshot, contentHash),
    text: snapshot.text,
  };
}

interface DocumentSnapshot {
  workspaceId: DocumentReference["workspaceId"];
  rootId: DocumentReference["rootId"];
  uri: string;
  logicalPath: string;
  /** Omitted for on-disk content, which has no editor buffer and therefore no version. */
  editorVersion?: number;
  workspaceEpoch: number;
  languageId: string;
  isDirty: boolean;
  text: string;
}

function captureDiskDocument(
  uri: VscodeDocumentUriLike,
  text: string,
  context: DocumentMappingContext,
): DocumentSnapshot {
  assertMappingContext(context);
  return {
    workspaceId: context.workspace.workspaceId,
    rootId: context.root.rootId,
    uri: uri.toString(),
    logicalPath: relativeUriPath(context.rootUri, uri),
    workspaceEpoch: context.workspace.workspaceEpoch,
    languageId: "",
    // Disk content is by definition what was last saved.
    isDirty: false,
    text,
  };
}

function captureDocument(
  document: VscodeTextDocumentLike,
  context: DocumentMappingContext,
): DocumentSnapshot {
  const editorVersion = document.version;
  if (!Number.isSafeInteger(editorVersion) || editorVersion < 0) {
    throw new Error("VS Code document version must be a non-negative safe integer");
  }
  assertMappingContext(context);

  return {
    workspaceId: context.workspace.workspaceId,
    rootId: context.root.rootId,
    uri: document.uri.toString(),
    logicalPath: relativeUriPath(context.rootUri, document.uri),
    editorVersion,
    workspaceEpoch: context.workspace.workspaceEpoch,
    languageId: document.languageId,
    isDirty: document.isDirty,
    text: document.getText(),
  };
}

function assertMappingContext(context: DocumentMappingContext): void {
  if (context.workspace.workspaceId.length === 0 || context.root.rootId.length === 0) {
    throw new Error("Workspace and root identifiers are required");
  }
  if (
    !context.workspace.roots.some(
      (candidate) => candidate.rootId === context.root.rootId && candidate.uri === context.root.uri,
    )
  ) {
    throw new Error("Selected root does not belong to the workspace");
  }
  if (context.root.uri !== context.rootUri.toString()) {
    throw new Error("Workspace root URI does not match its VS Code URI");
  }
}

function createDocumentReference(
  snapshot: DocumentSnapshot,
  contentHash: `sha256:${string}`,
): DocumentReference {
  return {
    workspaceId: snapshot.workspaceId,
    rootId: snapshot.rootId,
    uri: snapshot.uri,
    logicalPath: snapshot.logicalPath,
    revision: {
      ...(snapshot.editorVersion === undefined ? {} : { editorVersion: snapshot.editorVersion }),
      contentHash,
      workspaceEpoch: snapshot.workspaceEpoch,
    },
    positionEncoding: "utf-16",
    ...(snapshot.languageId.length === 0 ? {} : { languageId: snapshot.languageId }),
    isDirty: snapshot.isDirty,
  };
}

function relativeUriPath(root: VscodeDocumentUriLike, document: VscodeDocumentUriLike): string {
  if (root.scheme !== document.scheme || root.authority !== document.authority) {
    throw new Error("Document is outside the selected workspace root");
  }
  const relative = posix.relative(root.path, document.path);
  if (relative.length === 0 || relative === ".." || relative.startsWith("../")) {
    throw new Error("Document is outside the selected workspace root");
  }
  return relative;
}
