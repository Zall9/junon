/**
 * IDE Bridge Client — public entry point.
 *
 * Phase 2 implements daemon discovery, authentication, bidirectional typed
 * JSON-RPC, notifications, timeouts, cancellation, and opt-in reconnection.
 */

export * from "./discovery/discovery-file.js";
export * from "./connection/authenticated-connection.js";
export * from "./connection/connect.js";
export * from "./connection/reconnecting-connection.js";
export type {
  BridgeAdapterRequestContext,
  BridgeAdapterRequestHandler,
  BridgeInboundRequestOptions,
  BridgeNotificationHandler,
  BridgeRequestOptions,
} from "./connection/json-rpc-engine.js";
export {
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  DEFAULT_INBOUND_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_INBOUND_REQUESTS,
  MAX_CLIENT_REQUEST_TIMEOUT_MS,
  MAX_INBOUND_REQUEST_TIMEOUT_MS,
  MAX_INBOUND_REQUESTS,
} from "./connection/json-rpc-engine.js";
export * from "./errors.js";
export * from "./metadata.js";
