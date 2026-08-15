# packages/bridge-client/src/

## Responsibility

The root source directory is the public entry point of the IDE Bridge client library. It re-exports discovery, one-shot and reconnecting connections, authenticated sessions, bidirectional JSON-RPC types (outbound request, inbound adapter request, notification), connection limits, typed errors, and client metadata through one import surface (`@ide-bridge/bridge-client`).

## Design Patterns

- **Barrel/Facade Pattern**: `index.ts` re-exports everything from submodules, hiding internal file structure from consumers (`index.ts:8-28`).
- **Type-Safe Error Hierarchy**: All errors extend `Error` with `override readonly name` for discrimination; some carry structured protocol data (`errors.ts:7-100`).
- **Const Identity Metadata**: Client name/version are `as const` literals, enabling literal-type inference (`metadata.ts:1-2`).

## Key Types

### Error Classes (`errors.ts`)

| Class                                | Line | Purpose                                                                                                                                             |
| ------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BridgeClientConfigurationError`     | 7    | Invalid options passed by the caller (e.g. bad timeout, bad discovery, bad reconnect settings).                                                     |
| `BridgeClientConnectionError`        | 11   | Transport-level failures: socket errors, close during handshake, send failures. Base class for `BridgeClientReconnectingError`.                     |
| `BridgeClientReconnectingError`      | 15   | Immediate failure for calls submitted while no physical generation is usable. Extends `BridgeClientConnectionError`.                                |
| `BridgeClientHandshakeTimeoutError`  | 23   | Handshake did not complete within the configured window.                                                                                            |
| `BridgeClientProtocolViolationError` | 27   | Daemon sent a message that violates IDEBP protocol (binary frame, bad JSON, wrong response shape).                                                  |
| `BridgeAdapterRequestError`          | 33   | Lets an adapter handler return schema-validated normalized error data without exposing arbitrary exception text. Carries `data: ProtocolErrorData`. |
| `BridgeClientRequestTimeoutError`    | 43   | Application request exceeded its timeout. Carries `method: IDEBPApplicationMethod` and `timeoutMs: number`.                                         |
| `BridgeClientRequestCancelledError`  | 55   | Request was cancelled via `AbortSignal`. Carries `method: IDEBPApplicationMethod`.                                                                  |
| `BridgeClientRpcError`               | 67   | Daemon returned a JSON-RPC error response. Carries `protocolCode`, `retryable: boolean`, and deep-cloned `details`.                                 |
| `BridgeHandshakeRejectedError`       | 84   | Daemon rejected the handshake. Carries `protocolCode: HandshakeRejectionCode`, `retryable: false`, and optional `supportedProtocol` range.          |

### `HandshakeRejectionCode` (`errors.ts:81-82`)

Union: `"INVALID_REQUEST" | "AUTHENTICATION_FAILED" | "UNSUPPORTED_PROTOCOL_VERSION"`.

### `ProtocolErrorData` (`errors.ts:31`)

Type alias for `IDEBPJSONRPCErrorResponse["error"]["data"]` — the structured error payload from the protocol.

### `ProtocolErrorDetails<T>` (`errors.ts:65`)

Utility type: `T extends { details?: infer D } ? D : never` — extracts the `details` field type from a `ProtocolErrorData` variant.

### Metadata Constants (`metadata.ts`)

- `CLIENT_NAME = "ide-bridge-client"` (line 1) — used in handshake `clientInfo` defaults.
- `CLIENT_VERSION = "0.0.0"` (line 2) — used in handshake `clientInfo` defaults.

### Exported Connection Limit Constants (`index.ts:19-26`)

| Constant                             | Source                  | Value     |
| ------------------------------------ | ----------------------- | --------- |
| `DEFAULT_CLIENT_REQUEST_TIMEOUT_MS`  | `json-rpc-engine.ts:40` | `30_000`  |
| `DEFAULT_INBOUND_REQUEST_TIMEOUT_MS` | `json-rpc-engine.ts:42` | `30_000`  |
| `DEFAULT_MAX_INBOUND_REQUESTS`       | `json-rpc-engine.ts:44` | `128`     |
| `MAX_CLIENT_REQUEST_TIMEOUT_MS`      | `json-rpc-engine.ts:41` | `300_000` |
| `MAX_INBOUND_REQUEST_TIMEOUT_MS`     | `json-rpc-engine.ts:43` | `300_000` |
| `MAX_INBOUND_REQUESTS`               | `json-rpc-engine.ts:45` | `1_024`   |

### Exported Connection Types (`index.ts:12-18`)

| Type                          | Source                     | Purpose                                                                                                     |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `BridgeAdapterRequestContext` | `json-rpc-engine.ts`       | Inbound context: `{ id, method, sessionId, signal }`; the session is the physical authenticated connection. |
| `BridgeAdapterRequestHandler` | `json-rpc-engine.ts:65-68` | Inbound handler function type.                                                                              |
| `BridgeInboundRequestOptions` | `json-rpc-engine.ts:54-57` | Inbound timeout/concurrency configuration.                                                                  |
| `BridgeNotificationHandler`   | `json-rpc-engine.ts:70-72` | Notification handler function type.                                                                         |
| `BridgeRequestOptions`        | `json-rpc-engine.ts:49-52` | Outbound request options: `{ timeoutMs?, signal? }`.                                                        |

## Key Functions

No standalone functions in this directory — it is purely re-exports, type declarations, and class definitions.

## Data & Control Flow

```
Consumer
  └─ import from index.ts
       ├─ export * from ./discovery/discovery-file.js      → readPrivateDiscoveryFile()
       ├─ export * from ./connection/authenticated-connection.js → AuthenticatedBridgeConnection, AuthenticatedBridgeSession
       ├─ export * from ./connection/connect.js             → connectBridgeClient(), connectBridgeClientFromDiscoveryFile(), ConnectBridgeClientOptions
       ├─ export * from ./connection/reconnecting-connection.js → ReconnectingBridgeConnection, connectReconnectingBridgeClientFromDiscoveryFile(), BridgeReconnectOptions, BridgeReconnectState
       ├─ export type { BridgeAdapterRequestContext, BridgeAdapterRequestHandler, BridgeInboundRequestOptions, BridgeNotificationHandler, BridgeRequestOptions }
       ├─ export const { DEFAULT_CLIENT_REQUEST_TIMEOUT_MS, DEFAULT_INBOUND_REQUEST_TIMEOUT_MS, DEFAULT_MAX_INBOUND_REQUESTS, MAX_CLIENT_REQUEST_TIMEOUT_MS, MAX_INBOUND_REQUEST_TIMEOUT_MS, MAX_INBOUND_REQUESTS }
       ├─ export * from ./errors.js                         → typed client and adapter errors
       └─ export * from ./metadata.js                       → CLIENT_NAME, CLIENT_VERSION
```

All flows converge on `index.ts` as the single public surface. Consumers never import from submodules directly.

## Integration Points

- **Consumed by**: `@ide-bridge/conformance` (integration tests), `integrations/serena` (Python integration via subprocess/FFI bridge), and any external IDE extension or tool that needs to communicate with an IDE Bridge daemon.
- **Depends on**: `@ide-bridge/protocol` (types, validators, parsers, method classification constants), `ws` (WebSocket client).
- **External boundaries**: No direct external boundaries at this level — delegates to `connection/` for WebSocket I/O and `discovery/` for file I/O.

## Common Gotchas

- `BridgeClientReconnectingError` extends `BridgeClientConnectionError`, so `instanceof BridgeClientConnectionError` catches reconnection-state failures too. Callers that need to distinguish should check `instanceof BridgeClientReconnectingError` first (`errors.ts:11-21`).
- `BridgeAdapterRequestError.data` is deep-cloned via `structuredClone` to avoid retaining references to mutable protocol objects (`errors.ts:39`).
- `BridgeClientRpcError.details` is deep-cloned via `structuredClone` to avoid retaining references to mutable protocol objects (`errors.ts:77`).
- `BridgeHandshakeRejectedError.retryable` is hardcoded `false` — all handshake rejections are terminal (`errors.ts:87`).
- `index.ts` uses `.js` extensions in re-export paths even though the source is `.ts` — this is required by Node's ESM resolution and TypeScript's `moduleResolution: NodeNext` (`index.ts:8-27`).
- The barrel export means importing `{ BridgeClientConfigurationError }` from the package root pulls in all submodule code; tree-shaking may not eliminate unused error classes if they appear in exported type unions.
- `index.ts` separates type exports (`export type`) from value exports (`export const`) for the JSON-RPC engine types and constants, ensuring types are erased at compile time while constants remain available at runtime (`index.ts:12-26`).
