import {
  connectBridgeClient,
  readPrivateDiscoveryFile,
  type AuthenticatedBridgeConnection,
} from "@ide-bridge/bridge-client";

import { CliOperationalError } from "./errors.js";

export const CLI_REQUEST_TIMEOUT_MS = 5_000;

export async function connectCliConsumer(
  discoveryFile: string,
): Promise<AuthenticatedBridgeConnection> {
  let discovery;
  try {
    discovery = await readPrivateDiscoveryFile(discoveryFile);
  } catch {
    throw new CliOperationalError("discovery-unavailable");
  }
  return await connectBridgeClient({
    discovery,
    role: "consumer",
    topology: { hostKind: "local", environmentKind: "local", uriSchemes: ["file"] },
    clientInfo: { name: "ide-bridge-cli", version: "0.0.0" },
  });
}

export async function withCliConsumer<T>(
  discoveryFile: string,
  operation: (connection: AuthenticatedBridgeConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectCliConsumer(discoveryFile);
  try {
    return await operation(connection);
  } finally {
    await connection.close().catch(() => undefined);
  }
}
