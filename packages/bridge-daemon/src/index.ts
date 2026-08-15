/**
 * IDE Bridge Daemon — public entry point.
 *
 * Phase 2 implements the WebSocket JSON-RPC 2.0 server, session registry,
 * routing, plan store, security primitives, session heartbeat, and redacted
 * structured logging. Process ownership and doctor commands live in
 * @ide-bridge/cli.
 */

export * from "./security/authentication-token.js";
export * from "./security/workspace-uri.js";
export * from "./discovery/discovery-file.js";
export * from "./daemon-server.js";
export * from "./metadata.js";
export * from "./observability/structured-logger.js";
export * from "./plan/in-memory-edit-store.js";
export * from "./routing/application-router.js";
export * from "./session/handshake-processor.js";
export * from "./session/session-registry.js";
export * from "./transport/loopback-websocket-server.js";
export * from "./transport/transport.js";
