import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

interface SchemaDocument extends Record<string, unknown> {
  $id: string;
  $defs?: Record<string, unknown>;
}

interface PublicContract {
  name: string;
  reference: string;
}

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(protocolDirectory, "schemas");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function listJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

function parseSchema(path: string): SchemaDocument {
  const value = readJson(path);
  if (!isRecord(value) || typeof value.$id !== "string") {
    throw new Error(`Protocol schema has no $id: ${path}`);
  }
  return value as SchemaDocument;
}

const schemaDocuments = listJsonFiles(schemasDirectory).map(parseSchema);
const schemasById = new Map(schemaDocuments.map((schema) => [schema.$id, schema]));

function resolvePointer(document: SchemaDocument, fragment: string): unknown {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) throw new Error(`Unsupported JSON pointer: ${fragment}`);

  let current: unknown = document;
  for (const rawSegment of fragment.slice(2).split("/")) {
    const segment = decodeURIComponent(rawSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`Unresolved JSON pointer segment ${segment} in ${document.$id}${fragment}`);
    }
    current = current[segment];
  }
  return current;
}

function resolveReference(
  reference: string,
  currentDocument: SchemaDocument,
): {
  document: SchemaDocument;
  schema: unknown;
} {
  if (reference.startsWith("#")) {
    return { document: currentDocument, schema: resolvePointer(currentDocument, reference) };
  }

  const hashIndex = reference.indexOf("#");
  const documentId = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex);
  const document = schemasById.get(documentId);
  if (document === undefined) throw new Error(`Unregistered schema reference: ${reference}`);
  return { document, schema: resolvePointer(document, fragment) };
}

function sampleString(schema: Record<string, unknown>): string {
  if (schema.format === "uri") return "file:///fixture/source.ts";
  if (schema.format === "date-time") return "2026-08-01T12:00:00Z";

  const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
  if (pattern.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
  if (pattern.startsWith("^adapter_")) return "adapter_fixture";
  if (pattern.startsWith("^session_")) return "session_fixture";
  if (pattern.startsWith("^ws_")) return "ws_fixture";
  if (pattern.startsWith("^root_")) return "root_fixture";
  if (pattern.startsWith("^plan_")) return "plan_fixture";
  if (pattern.startsWith("^undo_")) return "undo_fixture";
  if (pattern.includes("\\.(0|")) return "0.1.0";
  if (pattern.includes("(?:[./]")) return "symbol.references";
  if (pattern.includes("A-Za-z0-9+.-")) return "file";

  const minimumLength = typeof schema.minLength === "number" ? schema.minLength : 1;
  return "a".repeat(Math.max(1, minimumLength));
}

function mergeSamples(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return right;
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = key in merged ? mergeSamples(merged[key], value) : value;
  }
  return merged;
}

function hasConst(value: unknown): boolean {
  return isRecord(value) && "const" in value;
}

function hasRequiredProperties(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.required) && value.required.length > 0;
}

function hasReference(value: unknown): boolean {
  return isRecord(value) && typeof value.$ref === "string";
}

function createSample(schemaValue: unknown, currentDocument: SchemaDocument): unknown {
  if (schemaValue === true) return {};
  if (schemaValue === false || !isRecord(schemaValue)) {
    throw new Error(
      `Cannot create a sample for a false or malformed schema in ${currentDocument.$id}`,
    );
  }

  if (typeof schemaValue.$ref === "string") {
    const resolved = resolveReference(schemaValue.$ref, currentDocument);
    return createSample(resolved.schema, resolved.document);
  }
  if ("const" in schemaValue) return schemaValue.const;
  if (Array.isArray(schemaValue.enum) && schemaValue.enum.length > 0) return schemaValue.enum[0];

  if (Array.isArray(schemaValue.allOf)) {
    const baseSchema = { ...schemaValue };
    delete baseSchema.allOf;
    return schemaValue.allOf.reduce<unknown>(
      (sample, item) => mergeSamples(sample, createSample(item, currentDocument)),
      createSample(baseSchema, currentDocument),
    );
  }
  if (Array.isArray(schemaValue.oneOf) && schemaValue.oneOf.length > 0) {
    const baseSchema = { ...schemaValue };
    delete baseSchema.oneOf;
    const branch = schemaValue.oneOf[0];
    if (isRecord(branch) && Array.isArray(branch.required)) {
      baseSchema.required = [
        ...(Array.isArray(baseSchema.required) ? baseSchema.required : []),
        ...branch.required,
      ];
    }
    return mergeSamples(
      createSample(baseSchema, currentDocument),
      createSample(branch, currentDocument),
    );
  }
  if (Array.isArray(schemaValue.anyOf) && schemaValue.anyOf.length > 0) {
    const baseSchema = { ...schemaValue };
    delete baseSchema.anyOf;
    const branch = schemaValue.anyOf[0];
    if (isRecord(branch) && Array.isArray(branch.required)) {
      baseSchema.required = [
        ...(Array.isArray(baseSchema.required) ? baseSchema.required : []),
        ...branch.required,
      ];
    }
    return mergeSamples(
      createSample(baseSchema, currentDocument),
      createSample(branch, currentDocument),
    );
  }

  if (schemaValue.type === "object" || isRecord(schemaValue.properties)) {
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const required = new Set(
      Array.isArray(schemaValue.required)
        ? schemaValue.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const sample: Record<string, unknown> = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (
        required.has(name) ||
        hasConst(propertySchema) ||
        hasRequiredProperties(propertySchema) ||
        hasReference(propertySchema)
      ) {
        sample[name] = createSample(propertySchema, currentDocument);
      }
    }
    return sample;
  }

  if (schemaValue.type === "array") {
    const minimumItems = typeof schemaValue.minItems === "number" ? schemaValue.minItems : 0;
    const count = Math.max(minimumItems, schemaValue.contains === undefined ? 0 : 1);
    const sample: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const itemSchema =
        index === 0 && schemaValue.contains !== undefined
          ? schemaValue.contains
          : schemaValue.items;
      sample.push(createSample(itemSchema ?? true, currentDocument));
    }
    return sample;
  }
  if (schemaValue.type === "string") return sampleString(schemaValue);
  if (schemaValue.type === "integer" || schemaValue.type === "number") {
    return typeof schemaValue.minimum === "number" ? schemaValue.minimum : 0;
  }
  if (schemaValue.type === "boolean") return false;
  if (schemaValue.type === "null") return null;

  return {};
}

function collectMethodConstants(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, output);
  } else if (isRecord(value)) {
    if (isRecord(value.method) && typeof value.method.const === "string") {
      output.add(value.method.const);
    }
    for (const child of Object.values(value)) collectMethodConstants(child, output);
  }
  return output;
}

function collectPublicContracts(): PublicContract[] {
  const contracts: PublicContract[] = [];
  for (const document of schemaDocuments) {
    if (document.$id.includes("/method/")) {
      for (const name of Object.keys(document.$defs ?? {})) {
        if (name.endsWith("Request") || name.endsWith("Response")) {
          contracts.push({ name, reference: `${document.$id}#/$defs/${name}` });
        }
      }
    }
    if (document.$id.endsWith("/notification/events.schema.json")) {
      for (const [name, definition] of Object.entries(document.$defs ?? {})) {
        if (collectMethodConstants(definition).size === 1) {
          contracts.push({ name, reference: `${document.$id}#/$defs/${name}` });
        }
      }
    }
  }

  const topLevelIds = [
    "bridge/handshake-request.schema.json",
    "bridge/handshake-response.schema.json",
    "bridge/handshake-error-response.schema.json",
    "notification/cancel-request.schema.json",
    "error/error-response.schema.json",
  ];
  for (const suffix of topLevelIds) {
    const document = schemaDocuments.find(({ $id }) => $id.endsWith(`/${suffix}`));
    if (document === undefined) throw new Error(`Missing public schema ${suffix}`);
    contracts.push({ name: suffix, reference: document.$id });
  }
  return contracts;
}

const publicContracts = collectPublicContracts();
const referenceDocument = schemaDocuments[0];
if (referenceDocument === undefined) throw new Error("No protocol schemas were loaded");

function sampleFromReference(reference: string): unknown {
  const resolved = resolveReference(reference, referenceDocument);
  return createSample(resolved.schema, resolved.document);
}

describe("every public IDEBP message type", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemaDocuments) ajv.addSchema(schema);

  it("has an independently valid JSON serialization example", () => {
    expect(publicContracts).toHaveLength(73);
    for (const contract of publicContracts) {
      const sample = sampleFromReference(contract.reference);
      const validate = ajv.getSchema(contract.reference);

      expect(validate, contract.reference).toBeDefined();
      if (validate === undefined) throw new Error(`Schema was not compiled: ${contract.reference}`);
      expect(validate(sample), `${contract.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("round-trips every public message without changing its wire shape", () => {
    for (const contract of publicContracts) {
      const sample = sampleFromReference(contract.reference);
      const roundTripped = JSON.parse(JSON.stringify(sample)) as unknown;
      const validate = ajv.getSchema(contract.reference);
      if (validate === undefined) throw new Error(`Schema was not compiled: ${contract.reference}`);

      expect(roundTripped).toEqual(sample);
      expect(validate(roundTripped), contract.name).toBe(true);
    }
  });

  it("serializes every normalized error code", () => {
    const errorSchema = schemaDocuments.find(({ $id }) =>
      $id.endsWith("/error/error-response.schema.json"),
    );
    if (errorSchema === undefined) throw new Error("Missing normalized error schema");
    const errorCodes = resolvePointer(errorSchema, "#/$defs/errorCode");
    if (!isRecord(errorCodes) || !Array.isArray(errorCodes.enum)) {
      throw new Error("Normalized error codes are not an enum");
    }
    const validate = ajv.getSchema(errorSchema.$id);
    if (validate === undefined) throw new Error("Normalized error schema was not compiled");

    for (const code of errorCodes.enum) {
      const sample = createSample(errorSchema, errorSchema);
      if (!isRecord(sample) || !isRecord(sample.error) || !isRecord(sample.error.data)) {
        throw new Error("Generated normalized error sample is malformed");
      }
      sample.error.data.code = code;
      if (code === "INDEX_NOT_READY") {
        sample.error.data.retryable = true;
      } else if (code === "STALE_DOCUMENT") {
        sample.error.data.details = {
          currentRevision: sampleFromReference(
            "https://ide-bridge.dev/schemas/0.1.0/common/revision.schema.json#/$defs/revision",
          ),
        };
      } else if (code === "AMBIGUOUS_SYMBOL") {
        const candidate = sampleFromReference(
          "https://ide-bridge.dev/schemas/0.1.0/common/symbol.schema.json#/$defs/symbolLocator",
        );
        sample.error.data.details = { candidates: [candidate, candidate] };
      } else if (code === "PARTIAL_APPLY") {
        sample.error.data.details = {
          modifiedDocuments: [
            sampleFromReference(
              "https://ide-bridge.dev/schemas/0.1.0/common/edit-plan.schema.json#/$defs/modifiedDocument",
            ),
          ],
        };
      }
      const roundTripped = JSON.parse(JSON.stringify(sample)) as unknown;
      expect(validate(roundTripped), String(code)).toBe(true);
    }
  });
});
