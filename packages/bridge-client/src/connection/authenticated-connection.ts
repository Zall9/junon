import type {
  BridgeHandshakeResponse,
  IDEBPApplicationMethod,
  IDEBPEndpointTopology,
  IDEBPNotificationMethod,
  IDEBPNotificationParams,
  IDEBPProtocolVersion,
  IDEBPRequestParams,
  IDEBPResponseResult,
  IDEBPRoutedMethod,
  IDEBPSessionRole,
  SessionId,
} from "@ide-bridge/protocol";
import { WebSocket } from "ws";

import {
  ClientJsonRpcEngine,
  type BridgeAdapterRequestHandler,
  type BridgeInboundRequestOptions,
  type BridgeNotificationHandler,
  type BridgeRequestOptions,
} from "./json-rpc-engine.js";

export interface AuthenticatedBridgeSession {
  sessionId: SessionId;
  role: IDEBPSessionRole;
  protocolVersion: IDEBPProtocolVersion;
  daemonInfo: { name: string; version: string };
  daemonTopology: IDEBPEndpointTopology;
}

export class AuthenticatedBridgeConnection {
  readonly #socket: WebSocket;
  readonly #rpc: ClientJsonRpcEngine;
  readonly #session: AuthenticatedBridgeSession;
  readonly closed: Promise<void>;

  constructor(
    socket: WebSocket,
    result: BridgeHandshakeResponse["result"],
    options: BridgeInboundRequestOptions = {},
  ) {
    this.#socket = socket;
    this.#rpc = new ClientJsonRpcEngine(socket, result.role, result.sessionId, options);
    this.#session = {
      sessionId: result.sessionId,
      role: result.role,
      protocolVersion: result.protocolVersion,
      daemonInfo: { ...result.daemonInfo },
      daemonTopology: structuredClone(result.topology),
    };
    this.closed = this.#rpc.closed;
  }

  get session(): AuthenticatedBridgeSession {
    return structuredClone(this.#session);
  }

  get isOpen(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  request<M extends IDEBPApplicationMethod>(
    method: M,
    params: IDEBPRequestParams<M>,
    options?: BridgeRequestOptions,
  ): Promise<IDEBPResponseResult<M>> {
    return this.#rpc.request(method, params, options);
  }

  notify<M extends IDEBPNotificationMethod>(
    method: M,
    params: IDEBPNotificationParams<M>,
  ): Promise<void> {
    return this.#rpc.notify(method, params);
  }

  onNotification<M extends IDEBPNotificationMethod>(
    method: M,
    handler: BridgeNotificationHandler<M>,
  ): () => void {
    return this.#rpc.onNotification(method, handler);
  }

  onRequest<M extends IDEBPRoutedMethod>(
    method: M,
    handler: BridgeAdapterRequestHandler<M>,
  ): () => void {
    return this.#rpc.onRequest(method, handler);
  }

  async close(): Promise<void> {
    await this.#rpc.close();
  }
}
