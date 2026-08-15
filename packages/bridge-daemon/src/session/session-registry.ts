import type {
  Adapter,
  AdapterId,
  Capabilities,
  IdeRegisterRequest,
  Session,
  SessionId,
  Workspace,
  WorkspaceId,
  WorkspaceRoot,
  WorkspaceStatus,
} from "@ide-bridge/protocol";

import type { AuthenticatedTransportConnection } from "../transport/transport.js";

export type RegistryErrorCode =
  "ADAPTER_NOT_FOUND" | "WORKSPACE_NOT_FOUND" | "PERMISSION_DENIED" | "PRECONDITION_FAILED";

export class SessionRegistryError extends Error {
  override readonly name = "SessionRegistryError";
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode) {
    super("Session registry operation failed");
    this.code = code;
  }
}

interface SessionRecord {
  connection: AuthenticatedTransportConnection;
  snapshot: Session;
}

interface AdapterRecord {
  adapter: Adapter;
  sessionId: SessionId;
}

interface WorkspaceRecord {
  workspace: Workspace;
  status: WorkspaceStatus;
}

export interface RemovedSession {
  session: Session;
  adapter: Adapter | undefined;
  workspaces: Workspace[];
}

export class SessionRegistry {
  readonly #sessions = new Map<SessionId, SessionRecord>();
  readonly #adapters = new Map<AdapterId, AdapterRecord>();
  readonly #adapterBySession = new Map<SessionId, AdapterId>();
  readonly #workspaces = new Map<WorkspaceId, WorkspaceRecord>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get adapterCount(): number {
    return this.#adapters.size;
  }

  get workspaceCount(): number {
    return this.#workspaces.size;
  }

  open(connection: AuthenticatedTransportConnection): void {
    const session = connection.session;
    if (this.#sessions.has(session.sessionId)) {
      throw new SessionRegistryError("PRECONDITION_FAILED");
    }
    this.#sessions.set(session.sessionId, {
      connection,
      snapshot: {
        sessionId: session.sessionId,
        role: session.role,
        protocolVersion: session.protocolVersion,
        clientName: session.clientName,
        connectedAt: session.connectedAt,
        lastActivityAt: session.lastActivityAt,
      },
    });
  }

  touch(sessionId: SessionId): void {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw new SessionRegistryError("PERMISSION_DENIED");
    record.snapshot.lastActivityAt = this.#now().toISOString();
  }

  close(sessionId: SessionId): RemovedSession | undefined {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return undefined;
    this.#sessions.delete(sessionId);
    const adapterId = this.#adapterBySession.get(sessionId);
    const adapter = adapterId === undefined ? undefined : this.#adapters.get(adapterId)?.adapter;
    const workspaces = adapterId === undefined ? [] : this.#removeAdapter(adapterId);
    return {
      session: structuredClone(record.snapshot),
      adapter: adapter === undefined ? undefined : structuredClone(adapter),
      workspaces,
    };
  }

  registerAdapter(
    sessionId: SessionId,
    params: IdeRegisterRequest["params"],
  ): { adapter: Adapter; workspaces: Workspace[] } {
    const session = this.#requireSessionRole(sessionId, "adapter");
    if (this.#adapterBySession.has(sessionId) || this.#adapters.has(params.adapterId)) {
      throw new SessionRegistryError("PRECONDITION_FAILED");
    }
    const workspaceIds = new Set<WorkspaceId>();
    for (const workspace of params.workspaces) {
      if (
        workspace.adapterId !== params.adapterId ||
        workspaceIds.has(workspace.workspaceId) ||
        this.#workspaces.has(workspace.workspaceId)
      ) {
        throw new SessionRegistryError("PRECONDITION_FAILED");
      }
      workspaceIds.add(workspace.workspaceId);
    }

    const adapter: Adapter = {
      adapterId: params.adapterId,
      sessionId,
      name: params.name,
      version: params.version,
      ideKind: params.ideKind,
      ideVersion: params.ideVersion,
      positionEncodings: structuredClone(params.positionEncodings),
      capabilities: structuredClone(params.capabilities),
      connectedAt: session.connectedAt,
    };
    this.#adapters.set(params.adapterId, { adapter, sessionId });
    this.#adapterBySession.set(sessionId, params.adapterId);
    for (const workspace of params.workspaces) this.#addWorkspace(workspace);
    return {
      adapter: structuredClone(adapter),
      workspaces: params.workspaces.map((workspace) => structuredClone(workspace)),
    };
  }

  unregisterAdapter(sessionId: SessionId, adapterId: AdapterId): Workspace[] {
    this.assertAdapterOwnership(sessionId, adapterId);
    return this.#removeAdapter(adapterId);
  }

  listSessions(): Session[] {
    return [...this.#sessions.values()].map(({ snapshot }) => structuredClone(snapshot));
  }

  listAdapters(): Adapter[] {
    return [...this.#adapters.values()].map(({ adapter }) => structuredClone(adapter));
  }

  listWorkspaces(adapterId?: AdapterId): Workspace[] {
    if (adapterId !== undefined && !this.#adapters.has(adapterId)) {
      throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    }
    return [...this.#workspaces.values()]
      .map(({ workspace }) => workspace)
      .filter((workspace) => adapterId === undefined || workspace.adapterId === adapterId)
      .map((workspace) => structuredClone(workspace));
  }

  getWorkspace(workspaceId: WorkspaceId): Workspace {
    const record = this.#workspaces.get(workspaceId);
    if (record === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    return structuredClone(record.workspace);
  }

  getWorkspaceStatus(workspaceId: WorkspaceId): WorkspaceStatus {
    const record = this.#workspaces.get(workspaceId);
    if (record === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    return structuredClone(record.status);
  }

  getCapabilities(
    adapterId: AdapterId,
    workspaceId?: WorkspaceId,
  ): { adapterId: AdapterId; workspaceId?: WorkspaceId; capabilities: Capabilities } {
    const record = this.#adapters.get(adapterId);
    if (record === undefined) throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    if (workspaceId !== undefined) {
      const workspace = this.#workspaces.get(workspaceId)?.workspace;
      if (workspace === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
      if (workspace.adapterId !== adapterId) {
        throw new SessionRegistryError("PRECONDITION_FAILED");
      }
    }
    return {
      adapterId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      capabilities: structuredClone(record.adapter.capabilities),
    };
  }

  getWorkspaceConnection(workspaceId: WorkspaceId): AuthenticatedTransportConnection {
    const workspace = this.#workspaces.get(workspaceId)?.workspace;
    if (workspace === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    const adapterRecord = this.#adapters.get(workspace.adapterId);
    if (adapterRecord === undefined) throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    const connection = this.#sessions.get(adapterRecord.sessionId)?.connection;
    if (connection === undefined) throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    return connection;
  }

  consumerConnections(): AuthenticatedTransportConnection[] {
    return [...this.#sessions.values()]
      .filter(({ snapshot }) => snapshot.role === "consumer")
      .map(({ connection }) => connection);
  }

  assertAdapterOwnership(sessionId: SessionId, adapterId: AdapterId): void {
    const record = this.#adapters.get(adapterId);
    if (record === undefined) throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    if (record.sessionId !== sessionId) throw new SessionRegistryError("PERMISSION_DENIED");
  }

  assertWorkspaceOwnership(sessionId: SessionId, workspaceId: WorkspaceId): Workspace {
    const workspace = this.getWorkspace(workspaceId);
    this.assertAdapterOwnership(sessionId, workspace.adapterId);
    return workspace;
  }

  updateCapabilities(sessionId: SessionId, adapterId: AdapterId, capabilities: Capabilities): void {
    this.assertAdapterOwnership(sessionId, adapterId);
    const record = this.#adapters.get(adapterId);
    if (record === undefined) throw new SessionRegistryError("ADAPTER_NOT_FOUND");
    record.adapter.capabilities = structuredClone(capabilities);
  }

  openWorkspace(sessionId: SessionId, workspace: Workspace): void {
    this.assertAdapterOwnership(sessionId, workspace.adapterId);
    if (this.#workspaces.has(workspace.workspaceId)) {
      throw new SessionRegistryError("PRECONDITION_FAILED");
    }
    this.#addWorkspace(workspace);
  }

  closeWorkspace(sessionId: SessionId, workspaceId: WorkspaceId, adapterId: AdapterId): void {
    this.assertAdapterOwnership(sessionId, adapterId);
    const workspace = this.assertWorkspaceOwnership(sessionId, workspaceId);
    if (workspace.adapterId !== adapterId) throw new SessionRegistryError("PERMISSION_DENIED");
    this.#workspaces.delete(workspaceId);
  }

  updateWorkspaceRoots(
    sessionId: SessionId,
    workspaceId: WorkspaceId,
    adapterId: AdapterId,
    roots: [WorkspaceRoot, ...WorkspaceRoot[]],
    workspaceEpoch: number,
  ): void {
    this.assertAdapterOwnership(sessionId, adapterId);
    const record = this.#workspaces.get(workspaceId);
    if (record === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    if (record.workspace.adapterId !== adapterId) {
      throw new SessionRegistryError("PERMISSION_DENIED");
    }
    if (workspaceEpoch <= record.workspace.workspaceEpoch) {
      throw new SessionRegistryError("PRECONDITION_FAILED");
    }
    record.workspace.roots = structuredClone(roots);
    record.workspace.workspaceEpoch = workspaceEpoch;
  }

  updateWorkspaceStatus(sessionId: SessionId, status: WorkspaceStatus): void {
    this.assertWorkspaceOwnership(sessionId, status.workspaceId);
    const record = this.#workspaces.get(status.workspaceId);
    if (record === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    record.status = structuredClone(status);
  }

  /**
   * Updates only the trust level. Trust changing invalidates nothing else about the workspace —
   * its roots, epoch, documents, and handles are unaffected — so this deliberately touches one
   * field rather than replacing the record (ADR-0022).
   */
  updateWorkspaceTrust(
    sessionId: SessionId,
    workspaceId: WorkspaceId,
    adapterId: AdapterId,
    trust: Workspace["trust"],
  ): void {
    this.assertAdapterOwnership(sessionId, adapterId);
    const record = this.#workspaces.get(workspaceId);
    if (record === undefined) throw new SessionRegistryError("WORKSPACE_NOT_FOUND");
    if (record.workspace.adapterId !== adapterId) {
      throw new SessionRegistryError("PERMISSION_DENIED");
    }
    record.workspace = { ...record.workspace, trust };
  }

  #requireSessionRole(sessionId: SessionId, role: "adapter" | "consumer"): Session {
    const session = this.#sessions.get(sessionId)?.snapshot;
    if (session === undefined || session.role !== role) {
      throw new SessionRegistryError("PERMISSION_DENIED");
    }
    return session;
  }

  #addWorkspace(workspace: Workspace): void {
    this.#workspaces.set(workspace.workspaceId, {
      workspace: structuredClone(workspace),
      status: {
        workspaceId: workspace.workspaceId,
        state: "initializing",
        capabilitiesUnavailable: [],
        progress: { known: false },
      },
    });
  }

  #removeAdapter(adapterId: AdapterId): Workspace[] {
    const record = this.#adapters.get(adapterId);
    if (record === undefined) return [];
    const workspaces = [...this.#workspaces.values()]
      .map(({ workspace }) => workspace)
      .filter((workspace) => workspace.adapterId === adapterId);
    for (const workspace of workspaces) this.#workspaces.delete(workspace.workspaceId);
    this.#adapters.delete(adapterId);
    this.#adapterBySession.delete(record.sessionId);
    return workspaces.map((workspace) => structuredClone(workspace));
  }
}
