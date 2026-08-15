import type {
  IDEBPApplicationMethod,
  IDEBPJSONRPCErrorResponse,
  IDEBPProtocolVersion,
} from "@ide-bridge/protocol";

export class BridgeClientConfigurationError extends Error {
  override readonly name = "BridgeClientConfigurationError";
}

export class BridgeClientConnectionError extends Error {
  override readonly name: string = "BridgeClientConnectionError";
}

export class BridgeClientReconnectingError extends BridgeClientConnectionError {
  override readonly name = "BridgeClientReconnectingError";

  constructor() {
    super("IDEBP connection is reconnecting");
  }
}

export class BridgeClientHandshakeTimeoutError extends Error {
  override readonly name = "BridgeClientHandshakeTimeoutError";
}

export class BridgeClientProtocolViolationError extends Error {
  override readonly name = "BridgeClientProtocolViolationError";
}

type ProtocolErrorData = IDEBPJSONRPCErrorResponse["error"]["data"];

export class BridgeAdapterRequestError extends Error {
  override readonly name = "BridgeAdapterRequestError";
  readonly data: ProtocolErrorData;

  constructor(data: ProtocolErrorData) {
    super("IDEBP adapter request failed");
    this.data = structuredClone(data);
  }
}

export class BridgeClientRequestTimeoutError extends Error {
  override readonly name = "BridgeClientRequestTimeoutError";
  readonly method: IDEBPApplicationMethod;
  readonly timeoutMs: number;

  constructor(method: IDEBPApplicationMethod, timeoutMs: number) {
    super("IDEBP request timed out");
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class BridgeClientRequestCancelledError extends Error {
  override readonly name = "BridgeClientRequestCancelledError";
  readonly method: IDEBPApplicationMethod;

  constructor(method: IDEBPApplicationMethod) {
    super("IDEBP request was cancelled");
    this.method = method;
  }
}

type ProtocolErrorDetails<T> = T extends { details?: infer D } ? D : never;

export class BridgeClientRpcError extends Error {
  override readonly name = "BridgeClientRpcError";
  readonly protocolCode: ProtocolErrorData["code"];
  readonly retryable: boolean;
  readonly details: ProtocolErrorDetails<ProtocolErrorData> | undefined;

  constructor(data: ProtocolErrorData) {
    super("IDEBP request failed");
    this.protocolCode = data.code;
    this.retryable = data.retryable;
    this.details = "details" in data ? structuredClone(data.details) : undefined;
  }
}

export type HandshakeRejectionCode =
  "INVALID_REQUEST" | "AUTHENTICATION_FAILED" | "UNSUPPORTED_PROTOCOL_VERSION";

export class BridgeHandshakeRejectedError extends Error {
  override readonly name = "BridgeHandshakeRejectedError";
  readonly protocolCode: HandshakeRejectionCode;
  readonly retryable: false;
  readonly supportedProtocol:
    { minimum: IDEBPProtocolVersion; maximum: IDEBPProtocolVersion } | undefined;

  constructor(
    protocolCode: HandshakeRejectionCode,
    supportedProtocol?: { minimum: IDEBPProtocolVersion; maximum: IDEBPProtocolVersion },
  ) {
    super("IDEBP handshake was rejected");
    this.protocolCode = protocolCode;
    this.retryable = false;
    this.supportedProtocol = supportedProtocol === undefined ? undefined : { ...supportedProtocol };
  }
}
