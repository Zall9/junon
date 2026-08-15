import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import authenticationSchema from "../schemas/common/authentication.schema.json" with { type: "json" };
import protocolVersionSchema from "../schemas/common/protocol-version.schema.json" with { type: "json" };
import discoveryFileSchema from "../schemas/discovery/discovery-file.schema.json" with { type: "json" };
import type { IDEBPDiscoveryFile } from "./generated.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(authenticationSchema);
ajv.addSchema(protocolVersionSchema);
const validateDiscoveryFile = ajv.compile<IDEBPDiscoveryFile>(discoveryFileSchema);

export function assertIDEBPLoopbackEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("IDEBP endpoint must be an absolute WebSocket URL");
  }

  const port = Number(url.port);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "ws:" ||
    !isLoopback ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== "/rpc" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("IDEBP endpoint must be an uncredentialed loopback ws:// URL on /rpc");
  }
}

export function isIDEBPDiscoveryFile(value: unknown): value is IDEBPDiscoveryFile {
  if (!validateDiscoveryFile(value)) return false;
  try {
    assertIDEBPLoopbackEndpoint(value.endpoint);
    return true;
  } catch {
    return false;
  }
}

export function parseIDEBPDiscoveryFile(value: unknown): IDEBPDiscoveryFile {
  if (isIDEBPDiscoveryFile(value)) return value;

  const summary = (validateDiscoveryFile.errors ?? [])
    .map(({ instancePath, keyword }) => `${instancePath || "/"}:${keyword}`)
    .join(", ");
  throw new Error(`Invalid IDEBP discovery file${summary === "" ? "" : ` (${summary})`}`);
}
