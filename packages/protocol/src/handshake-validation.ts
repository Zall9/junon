import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import authenticationSchema from "../schemas/common/authentication.schema.json" with { type: "json" };
import identifiersSchema from "../schemas/common/identifiers.schema.json" with { type: "json" };
import jsonRpcIdSchema from "../schemas/common/json-rpc-id.schema.json" with { type: "json" };
import protocolVersionSchema from "../schemas/common/protocol-version.schema.json" with { type: "json" };
import sessionRoleSchema from "../schemas/common/session-role.schema.json" with { type: "json" };
import topologySchema from "../schemas/common/topology.schema.json" with { type: "json" };
import handshakeErrorResponseSchema from "../schemas/bridge/handshake-error-response.schema.json" with { type: "json" };
import handshakeRequestSchema from "../schemas/bridge/handshake-request.schema.json" with { type: "json" };
import handshakeResponseSchema from "../schemas/bridge/handshake-response.schema.json" with { type: "json" };
import type {
  BridgeHandshakeErrorResponse,
  BridgeHandshakeRequest,
  BridgeHandshakeResponse,
  JSONRPCRequestIdentifier,
} from "./generated.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of [
  authenticationSchema,
  identifiersSchema,
  jsonRpcIdSchema,
  protocolVersionSchema,
  sessionRoleSchema,
  topologySchema,
  handshakeErrorResponseSchema,
  handshakeRequestSchema,
  handshakeResponseSchema,
]) {
  ajv.addSchema(schema);
}

function requireValidator<T>(schemaId: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(schemaId);
  if (validator === undefined) throw new Error(`Canonical validator is missing for ${schemaId}`);
  return validator;
}

const validateHandshakeRequest = requireValidator<BridgeHandshakeRequest>(
  handshakeRequestSchema.$id,
);
const validateRequestIdentifier = requireValidator<JSONRPCRequestIdentifier>(jsonRpcIdSchema.$id);
const validateHandshakeResponse = requireValidator<BridgeHandshakeResponse>(
  handshakeResponseSchema.$id,
);
const validateHandshakeErrorResponse = requireValidator<BridgeHandshakeErrorResponse>(
  handshakeErrorResponseSchema.$id,
);

export type HandshakeRequestValidation =
  | { kind: "valid"; request: BridgeHandshakeRequest }
  | { kind: "authentication" }
  | { kind: "invalid" };

function isAuthenticationIssue(error: ErrorObject): boolean {
  if (error.instancePath.startsWith("/params/authentication")) return true;
  return (
    error.instancePath === "/params" &&
    error.keyword === "required" &&
    error.params["missingProperty"] === "authentication"
  );
}

/** Classify without exposing Ajv details or any supplied authentication value. */
export function classifyBridgeHandshakeRequest(value: unknown): HandshakeRequestValidation {
  if (validateHandshakeRequest(value)) return { kind: "valid", request: value };

  const errors = validateHandshakeRequest.errors ?? [];
  if (errors.length > 0 && errors.every(isAuthenticationIssue)) return { kind: "authentication" };
  return { kind: "invalid" };
}

export function isBridgeHandshakeRequest(value: unknown): value is BridgeHandshakeRequest {
  return classifyBridgeHandshakeRequest(value).kind === "valid";
}

export function isJSONRPCRequestIdentifier(value: unknown): value is JSONRPCRequestIdentifier {
  return validateRequestIdentifier(value);
}

export type HandshakeServerMessageValidation =
  | { kind: "success"; response: BridgeHandshakeResponse }
  | { kind: "error"; response: BridgeHandshakeErrorResponse }
  | { kind: "invalid" };

/** Validate the first daemon application message without exposing payload details in failures. */
export function classifyBridgeHandshakeServerMessage(
  value: unknown,
): HandshakeServerMessageValidation {
  if (validateHandshakeResponse(value)) return { kind: "success", response: value };
  if (validateHandshakeErrorResponse(value)) return { kind: "error", response: value };
  return { kind: "invalid" };
}

export function isBridgeHandshakeResponse(value: unknown): value is BridgeHandshakeResponse {
  return validateHandshakeResponse(value);
}

export function isBridgeHandshakeErrorResponse(
  value: unknown,
): value is BridgeHandshakeErrorResponse {
  return validateHandshakeErrorResponse(value);
}
