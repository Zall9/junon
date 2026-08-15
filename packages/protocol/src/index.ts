/**
 * IDE Bridge Protocol (IDEBP) — public entry point.
 *
 * JSON Schema 2020-12 files are canonical. Public TypeScript types are generated
 * from those schemas by scripts/generate-types.ts.
 */

export type * from "./generated.js";
export {
  assertIDEBPLoopbackEndpoint,
  isIDEBPDiscoveryFile,
  parseIDEBPDiscoveryFile,
} from "./discovery-validation.js";
export {
  classifyBridgeHandshakeServerMessage,
  classifyBridgeHandshakeRequest,
  isBridgeHandshakeErrorResponse,
  isBridgeHandshakeRequest,
  isBridgeHandshakeResponse,
  isJSONRPCRequestIdentifier,
  type HandshakeRequestValidation,
  type HandshakeServerMessageValidation,
} from "./handshake-validation.js";
export {
  IDEBP_APPLICATION_METHODS,
  IDEBP_ADAPTER_ORIGINATED_METHODS,
  IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
  IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS,
  IDEBP_CONSUMER_LOCAL_METHODS,
  IDEBP_NOTIFICATION_METHODS,
  IDEBP_ROUTED_METHODS,
  classifyIDEBPNotification,
  isIDEBPApplicationMethod,
  isIDEBPApplicationRequest,
  isIDEBPApplicationResponse,
  describeApplicationResponseFailure,
  isIDEBPJSONRPCErrorResponse,
  isIDEBPNotificationMethod,
  type IDEBPApplicationMethod,
  type IDEBPApplicationRequestByMethod,
  type IDEBPApplicationResponseByMethod,
  type IDEBPNotificationByMethod,
  type IDEBPNotificationMethod,
  type IDEBPNotificationParams,
  type IDEBPNotificationValidation,
  type IDEBPRequestParams,
  type IDEBPResponseResult,
  type IDEBPRoutedMethod,
} from "./application-validation.js";

export { isUriWithinWorkspaceRoot } from "./workspace-uri.js";

export const PROTOCOL_VERSION = "0.1.0" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Result ceiling applied by `workspace/searchSymbols` when the request omits `limit`.
 *
 * Adapters and the daemon must agree on this value: the adapter caps its result at the
 * effective limit and the daemon rejects any routed result that exceeds it. The schema
 * maximum for an explicit `limit` is 1000.
 */
export const IDEBP_DEFAULT_SYMBOL_SEARCH_LIMIT = 200;

/** Absolute ceiling for `workspace/searchSymbols`, matching the schema `limit` maximum. */
export const IDEBP_MAX_SYMBOL_SEARCH_LIMIT = 1000;

/**
 * Result ceiling for `symbol/getDefinition`, `symbol/getReferences`, and
 * `symbol/getImplementations`. These requests carry no `limit`, so the bound is fixed and shared:
 * the adapter truncates at it and the daemon rejects any result exceeding it.
 */
export const IDEBP_MAX_SYMBOL_LOCATIONS = 1000;

/** Maximum documents carried by one `diagnostics/getSnapshot` result. */
export const IDEBP_MAX_DIAGNOSTIC_DOCUMENTS = 500;

/** Maximum diagnostics carried for any single document in a snapshot. */
export const IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT = 1000;
