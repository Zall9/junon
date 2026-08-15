import { randomBytes } from "node:crypto";

import {
  PROTOCOL_VERSION,
  classifyBridgeHandshakeRequest,
  isJSONRPCRequestIdentifier,
} from "@ide-bridge/protocol";
import type {
  AuthenticationFailed,
  BridgeHandshakeErrorResponse,
  BridgeHandshakeResponse,
  IDEBPEndpointTopology,
  IDEBPProtocolVersion,
  IDEBPSessionRole,
  InvalidRequest,
  JSONRPCRequestIdentifier,
  ResponseId,
  SessionId,
  UnsupportedProtocolVersion,
} from "@ide-bridge/protocol";

import { DAEMON_NAME, DAEMON_VERSION } from "../metadata.js";
import {
  authenticationTokensEqual,
  isAuthenticationToken,
} from "../security/authentication-token.js";

const PROTOCOL_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SESSION_ID_PATTERN = /^session_[A-Za-z0-9_-]+$/u;

const DEFAULT_DAEMON_TOPOLOGY: IDEBPEndpointTopology = {
  hostKind: "local",
  environmentKind: "local",
  uriSchemes: ["file"],
};

export interface AuthenticatedSession {
  sessionId: SessionId;
  role: IDEBPSessionRole;
  protocolVersion: IDEBPProtocolVersion;
  clientName: string;
  clientVersion: string;
  clientTopology: IDEBPEndpointTopology;
  connectedAt: string;
  lastActivityAt: string;
}

export interface HandshakeProcessorOptions {
  expectedToken: string;
  supportedProtocolVersions?: readonly IDEBPProtocolVersion[];
  createSessionId?: () => SessionId;
  now?: () => Date;
}

export type HandshakeOutcome =
  | { accepted: true; response: BridgeHandshakeResponse; session: AuthenticatedSession }
  | { accepted: false; response: BridgeHandshakeErrorResponse };

function parseProtocolVersion(version: string): readonly [bigint, bigint, bigint] {
  const match = PROTOCOL_VERSION_PATTERN.exec(version);
  if (match === null)
    throw new Error("Supported protocol versions must be stable semantic versions");
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("Supported protocol version segments could not be parsed");
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

export function compareProtocolVersions(left: string, right: string): number {
  const leftParts = parseProtocolVersion(left);
  const rightParts = parseProtocolVersion(right);
  for (const [leftPart, rightPart] of [
    [leftParts[0], rightParts[0]],
    [leftParts[1], rightParts[1]],
    [leftParts[2], rightParts[2]],
  ] as const) {
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function recoverResponseId(value: unknown): ResponseId {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  return isJSONRPCRequestIdentifier(value.id) ? value.id : null;
}

function invalidRequest(id: ResponseId): InvalidRequest {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32600,
      message: "Invalid handshake request",
      data: { code: "INVALID_REQUEST", retryable: false },
    },
  };
}

export function createInvalidHandshakeRequestResponse(value: unknown): InvalidRequest {
  return invalidRequest(recoverResponseId(value));
}

function authenticationFailed(id: ResponseId): AuthenticationFailed {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message: "Authentication failed",
      data: { code: "AUTHENTICATION_FAILED", retryable: false },
    },
  };
}

function unsupportedProtocolVersion(
  id: JSONRPCRequestIdentifier,
  minimum: string,
  maximum: string,
): UnsupportedProtocolVersion {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32002,
      message: "No compatible protocol version",
      data: {
        code: "UNSUPPORTED_PROTOCOL_VERSION",
        retryable: false,
        supportedProtocol: { minimum, maximum },
      },
    },
  };
}

export class HandshakeProcessor {
  readonly #expectedToken: string;
  readonly #supportedVersions: readonly IDEBPProtocolVersion[];
  readonly #createSessionId: () => SessionId;
  readonly #now: () => Date;

  constructor(options: HandshakeProcessorOptions) {
    if (!isAuthenticationToken(options.expectedToken)) {
      throw new Error("Expected handshake token is not a valid authentication token");
    }
    const versions = [...new Set(options.supportedProtocolVersions ?? [PROTOCOL_VERSION])].sort(
      compareProtocolVersions,
    );
    if (versions.length === 0)
      throw new Error("At least one supported protocol version is required");

    this.#expectedToken = options.expectedToken;
    this.#supportedVersions = versions;
    this.#createSessionId =
      options.createSessionId ?? (() => `session_${randomBytes(18).toString("base64url")}`);
    this.#now = options.now ?? (() => new Date());
  }

  process(value: unknown): HandshakeOutcome {
    const id = recoverResponseId(value);
    const validation = classifyBridgeHandshakeRequest(value);
    if (validation.kind === "authentication") {
      return { accepted: false, response: authenticationFailed(id) };
    }
    if (validation.kind === "invalid") {
      return { accepted: false, response: invalidRequest(id) };
    }

    const request = validation.request;
    if (!authenticationTokensEqual(this.#expectedToken, request.params.authentication.token)) {
      return { accepted: false, response: authenticationFailed(request.id) };
    }

    const { minimum, maximum } = request.params.protocol;
    if (compareProtocolVersions(minimum, maximum) > 0) {
      return { accepted: false, response: invalidRequest(request.id) };
    }
    const selectedVersion = this.#supportedVersions.findLast(
      (version) =>
        compareProtocolVersions(version, minimum) >= 0 &&
        compareProtocolVersions(version, maximum) <= 0,
    );
    if (selectedVersion === undefined) {
      const supportedMinimum = this.#supportedVersions[0];
      const supportedMaximum = this.#supportedVersions.at(-1);
      if (supportedMinimum === undefined || supportedMaximum === undefined) {
        throw new Error("Supported protocol range is unavailable");
      }
      return {
        accepted: false,
        response: unsupportedProtocolVersion(request.id, supportedMinimum, supportedMaximum),
      };
    }

    const sessionId = this.#createSessionId();
    if (!SESSION_ID_PATTERN.test(sessionId))
      throw new Error("Session ID factory returned an invalid ID");
    const timestamp = this.#now().toISOString();
    const session: AuthenticatedSession = {
      sessionId,
      role: request.params.role,
      protocolVersion: selectedVersion,
      clientName: request.params.clientInfo.name,
      clientVersion: request.params.clientInfo.version,
      clientTopology: structuredClone(request.params.topology),
      connectedAt: timestamp,
      lastActivityAt: timestamp,
    };
    const response: BridgeHandshakeResponse = {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: session.sessionId,
        role: session.role,
        protocolVersion: session.protocolVersion,
        daemonInfo: { name: DAEMON_NAME, version: DAEMON_VERSION },
        topology: structuredClone(DEFAULT_DAEMON_TOPOLOGY),
      },
    };
    return { accepted: true, response, session };
  }
}
