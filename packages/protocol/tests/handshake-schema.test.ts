import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

interface FixtureDefinition {
  path: string;
  schema: string;
  valid: boolean;
}

interface FixtureManifest {
  fixtures: FixtureDefinition[];
}

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(protocolDirectory, "schemas");
const fixturesDirectory = join(protocolDirectory, "fixtures");
const fixtureSchemasDirectory = join(fixturesDirectory, "schemas");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  const schemaReferences: string[] = [];
  for (const schemaPath of [
    ...listJsonFiles(schemasDirectory),
    ...listJsonFiles(fixtureSchemasDirectory),
  ]) {
    const schema = readJson(schemaPath);
    ajv.addSchema(schema);

    if (typeof schema.$id === "string") {
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

  return ajv;
}

const manifest = readJson(join(fixturesDirectory, "manifest.json")) as FixtureManifest;

describe("IDEBP wire-contract compatibility", () => {
  const ajv = createValidator();

  for (const fixture of manifest.fixtures) {
    it(`${fixture.valid ? "accepts" : "rejects"} ${fixture.path}`, () => {
      const validate = ajv.getSchema(fixture.schema);
      expect(validate, `schema ${fixture.schema} is registered`).toBeDefined();

      const data = readJson(join(fixturesDirectory, fixture.path));
      expect(validate!(data), JSON.stringify(validate!.errors, null, 2)).toBe(fixture.valid);
    });
  }

  it("round-trips every valid fixture without changing its wire shape", () => {
    for (const fixture of manifest.fixtures.filter(({ valid }) => valid)) {
      const original = readJson(join(fixturesDirectory, fixture.path));
      const roundTripped = JSON.parse(JSON.stringify(original));
      const validate = ajv.getSchema(fixture.schema)!;

      expect(roundTripped).toEqual(original);
      expect(validate(roundTripped), JSON.stringify(validate.errors, null, 2)).toBe(true);
    }
  });

  it("tracks every protocol fixture in the compatibility manifest", () => {
    const listed = new Set(manifest.fixtures.map(({ path }) => path));
    const present = listJsonFiles(fixturesDirectory)
      .map((path) => relative(fixturesDirectory, path))
      // `schemas/` holds schema documents, and `vectors/` holds cross-language behaviour vectors
      // consumed directly by adapter test suites (ADR-0025). Neither is a wire fixture validated
      // against a schema, so neither belongs in this manifest.
      .filter(
        (path) =>
          path !== "manifest.json" && !path.startsWith("schemas/") && !path.startsWith("vectors/"),
      );

    expect([...listed].sort()).toEqual(present.sort());
  });
});
