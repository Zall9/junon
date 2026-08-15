import { randomBytes } from "node:crypto";

import {
  PROTOCOL_VERSION,
  classifyBridgeHandshakeServerMessage,
  isBridgeHandshakeRequest,
  parseIDEBPDiscoveryFile,
} from "@ide-bridge/protocol";
import type {
  BridgeHandshakeErrorResponse,
  BridgeHandshakeRequest,
  IDEBPDiscoveryFile,
  IDEBPEndpointTopology,
  IDEBPSessionRole,
  JSONRPCRequestIdentifier,
} from "@ide-bridge/protocol";
import { WebSocket, type RawData } from "ws";

import {
  BridgeClientConfigurationError,
  BridgeClientConnectionError,
  BridgeClientHandshakeTimeoutError,
  BridgeClientProtocolViolationError,
  BridgeHandshakeRejectedError,
} from "../errors.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../metadata.js";
import { readPrivateDiscoveryFile } from "../discovery/discovery-file.js";
import { AuthenticatedBridgeConnection } from "./authenticated-connection.js";
import {
  DEFAULT_INBOUND_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_INBOUND_REQUESTS,
  MAX_INBOUND_REQUEST_TIMEOUT_MS,
  MAX_INBOUND_REQUESTS,
  type BridgeInboundRequestOptions,
} from "./json-rpc-engine.js";

export const DEFAULT_CLIENT_HANDSHAKE_TIMEOUT_MS = 4_000;
export const MAX_CLIENT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const MAX_CLIENT_MESSAGE_BYTES = 10 * 1024 * 1024;

export interface ConnectBridgeClientOptions extends BridgeInboundRequestOptions {
  discovery: IDEBPDiscoveryFile;
  role: IDEBPSessionRole;
  topology: IDEBPEndpointTopology;
  clientInfo?: { name: string; version: string };
  handshakeTimeoutMs?: number;
  createRequestId?: () => JSONRPCRequestIdentifier;
  signal?: AbortSignal;
}

export interface ConnectBridgeClientFromDiscoveryFileOptions extends Omit<
  ConnectBridgeClientOptions,
  "discovery"
> {
  /**
   * Replaces only the validated discovery endpoint. Authentication and all
   * other metadata still come from the private discovery file.
   */
  endpointOverride?: string;
}

function parseTextMessage(data: RawData, isBinary: boolean): unknown {
  if (isBinary) throw new Error("Binary handshake response");
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data.toString("utf8");
  return JSON.parse(text) as unknown;
}

function rejectionFrom(response: BridgeHandshakeErrorResponse): BridgeHandshakeRejectedError {
  const { data } = response.error;
  return new BridgeHandshakeRejectedError(
    data.code,
    "supportedProtocol" in data ? data.supportedProtocol : undefined,
  );
}

function buildRequest(options: ConnectBridgeClientOptions): BridgeHandshakeRequest {
  const request: unknown = {
    jsonrpc: "2.0",
    id: options.createRequestId?.() ?? `handshake_${randomBytes(18).toString("base64url")}`,
    method: "bridge/handshake",
    params: {
      authentication: { method: "token", token: options.discovery.token },
      role: options.role,
      protocol: { minimum: PROTOCOL_VERSION, maximum: PROTOCOL_VERSION },
      topology: structuredClone(options.topology),
      clientInfo: {
        ...(options.clientInfo ?? { name: CLIENT_NAME, version: CLIENT_VERSION }),
      },
    },
  };
  if (!isBridgeHandshakeRequest(request)) {
    throw new BridgeClientConfigurationError("Bridge client handshake options are invalid");
  }
  return request;
}

export async function connectBridgeClient(
  options: ConnectBridgeClientOptions,
): Promise<AuthenticatedBridgeConnection> {
  if (options.signal?.aborted === true) {
    throw new BridgeClientConnectionError("IDEBP connection attempt was cancelled");
  }
  let discovery: IDEBPDiscoveryFile;
  try {
    discovery = parseIDEBPDiscoveryFile(options.discovery);
  } catch {
    throw new BridgeClientConfigurationError("Discovery metadata is invalid");
  }
  if (discovery.protocolVersion !== PROTOCOL_VERSION) {
    throw new BridgeClientConfigurationError("Discovery protocol version is incompatible");
  }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_CLIENT_HANDSHAKE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 1 ||
    handshakeTimeoutMs > MAX_CLIENT_HANDSHAKE_TIMEOUT_MS
  ) {
    throw new BridgeClientConfigurationError(
      `handshakeTimeoutMs must be between 1 and ${String(MAX_CLIENT_HANDSHAKE_TIMEOUT_MS)}`,
    );
  }
  const inboundRequestTimeoutMs =
    options.inboundRequestTimeoutMs ?? DEFAULT_INBOUND_REQUEST_TIMEOUT_MS;
  const maxInboundRequests = options.maxInboundRequests ?? DEFAULT_MAX_INBOUND_REQUESTS;
  if (
    !Number.isSafeInteger(inboundRequestTimeoutMs) ||
    inboundRequestTimeoutMs < 1 ||
    inboundRequestTimeoutMs > MAX_INBOUND_REQUEST_TIMEOUT_MS ||
    !Number.isSafeInteger(maxInboundRequests) ||
    maxInboundRequests < 1 ||
    maxInboundRequests > MAX_INBOUND_REQUESTS
  ) {
    throw new BridgeClientConfigurationError("Inbound request limits are invalid");
  }
  let request: BridgeHandshakeRequest;
  try {
    request = buildRequest({ ...options, discovery });
  } catch (error) {
    if (error instanceof BridgeClientConfigurationError) throw error;
    throw new BridgeClientConfigurationError("Bridge client handshake options are invalid");
  }

  return await new Promise<AuthenticatedBridgeConnection>((resolve, reject) => {
    const socket = new WebSocket(discovery.endpoint, {
      followRedirects: false,
      handshakeTimeout: handshakeTimeoutMs,
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    socket.on("error", () => undefined);
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new BridgeClientHandshakeTimeoutError("IDEBP handshake timed out"));
    }, handshakeTimeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.terminate();
      reject(error);
    };
    const onOpen = (): void => {
      socket.send(JSON.stringify(request), (error) => {
        if (error != null) fail(new BridgeClientConnectionError("Could not send IDEBP handshake"));
      });
    };
    const onMessage = (data: RawData, isBinary: boolean): void => {
      let value: unknown;
      try {
        value = parseTextMessage(data, isBinary);
      } catch {
        fail(new BridgeClientProtocolViolationError("Daemon sent an invalid handshake response"));
        return;
      }

      const validation = classifyBridgeHandshakeServerMessage(value);
      if (validation.kind === "invalid" || validation.response.id !== request.id) {
        fail(new BridgeClientProtocolViolationError("Daemon sent an invalid handshake response"));
        return;
      }
      if (validation.kind === "error") {
        fail(rejectionFrom(validation.response));
        return;
      }
      if (
        validation.response.result.role !== request.params.role ||
        validation.response.result.protocolVersion !== PROTOCOL_VERSION
      ) {
        fail(new BridgeClientProtocolViolationError("Daemon handshake response is inconsistent"));
        return;
      }

      settled = true;
      const connection = new AuthenticatedBridgeConnection(socket, validation.response.result, {
        inboundRequestTimeoutMs,
        maxInboundRequests,
      });
      cleanup();
      resolve(connection);
    };
    const onError = (): void => {
      fail(new BridgeClientConnectionError("Could not connect to IDEBP daemon"));
    };
    const onClose = (): void => {
      fail(new BridgeClientConnectionError("IDEBP daemon closed during handshake"));
    };
    const onAbort = (): void => {
      fail(new BridgeClientConnectionError("IDEBP connection attempt was cancelled"));
    };

    socket.once("open", onOpen);
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
  });
}

export async function connectBridgeClientFromDiscoveryFile(
  filePath: string,
  options: ConnectBridgeClientFromDiscoveryFileOptions,
): Promise<AuthenticatedBridgeConnection> {
  const discovered = await readPrivateDiscoveryFile(filePath);
  const { endpointOverride, ...connectionOptions } = options;
  const discovery =
    endpointOverride === undefined ? discovered : { ...discovered, endpoint: endpointOverride };
  return await connectBridgeClient({ ...connectionOptions, discovery });
}
