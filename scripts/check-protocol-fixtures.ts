import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

interface FixtureDefinition {
  path: string;
  schema: string;
  valid: boolean;
}

interface FixtureManifest {
  fixtures: FixtureDefinition[];
}

interface SchemaDocument extends Record<string, unknown> {
  $id?: string;
  $defs?: Record<string, unknown>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolDirectory = join(repositoryRoot, "packages", "protocol");
const schemasDirectory = join(protocolDirectory, "schemas");
const fixturesDirectory = join(protocolDirectory, "fixtures");
const fixtureSchemasDirectory = join(fixturesDirectory, "schemas");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function listJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

function isFixtureManifest(value: unknown): value is FixtureManifest {
  if (typeof value !== "object" || value === null || !("fixtures" in value)) {
    return false;
  }

  return Array.isArray(value.fixtures);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaReferences: string[] = [];
for (const schemaPath of [
  ...listJsonFiles(schemasDirectory),
  ...listJsonFiles(fixtureSchemasDirectory),
]) {
  const schema = readJson(schemaPath) as SchemaDocument;
  ajv.addSchema(schema);

  if (schema.$id !== undefined) {
    schemaReferences.push(schema.$id);
    for (const definitionName of Object.keys(schema.$defs ?? {})) {
      schemaReferences.push(`${schema.$id}#/$defs/${definitionName}`);
    }
  }
}

for (const schemaReference of schemaReferences) {
  if (ajv.getSchema(schemaReference) === undefined) {
    throw new Error(`Protocol schema could not be compiled: ${schemaReference}`);
  }
}

const manifestValue = readJson(join(fixturesDirectory, "manifest.json"));
if (!isFixtureManifest(manifestValue)) {
  throw new Error("Protocol fixture manifest has an invalid shape");
}

const failures: string[] = [];
for (const fixture of manifestValue.fixtures) {
  const validate = ajv.getSchema(fixture.schema);
  if (validate === undefined) {
    failures.push(`${fixture.path}: schema is not registered: ${fixture.schema}`);
    continue;
  }

  const actual = validate(readJson(join(fixturesDirectory, fixture.path))) === true;
  if (actual !== fixture.valid) {
    failures.push(
      `${fixture.path}: expected valid=${String(fixture.valid)}, got valid=${String(actual)}\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`Protocol fixture validation failed:\n${failures.join("\n")}`);
}

console.log(
  `Compiled ${String(schemaReferences.length)} schema entries and validated ${String(manifestValue.fixtures.length)} protocol fixtures.`,
);
