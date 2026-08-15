# scripts/

## Responsibility

Build-time tooling for the IDE Bridge Protocol. Two scripts: `generate-types.ts` generates `packages/protocol/src/generated.ts` from JSON Schema 2020-12 files, and `check-protocol-fixtures.ts` validates protocol test fixtures against their schemas. Both run via `node` (no CLI arguments for fixtures; `--check` flag for type generation). These scripts are invoked through npm scripts defined in the root `package.json` (`pnpm protocol:generate`, `node scripts/check-protocol-fixtures.ts` per `AGENTS.md` §7).

## Design Patterns

- **Schema-first code generation**: `generate-types.ts` reads canonical JSON Schema files and produces TypeScript types via `json-schema-to-typescript`, ensuring types are always derived from schemas, never hand-written (`generate-types.ts:1-6`).
- **Custom $ref resolver (no HTTP)**: The generator uses a custom resolver named `"idebp"` that resolves `https://ide-bridge.dev/schemas/0.1.0/` URIs from in-memory schema maps, with the HTTP resolver explicitly disabled (`generate-types.ts:83-102`). Prevents network access during code generation.
- **Staleness detection via `--check`**: When invoked with `--check`, the generator compares generated output to the existing file and throws if they differ, enabling CI to detect uncommitted schema changes (`generate-types.ts:128-132`).
- **Fixture-driven validation**: `check-protocol-fixtures.ts` reads a manifest of expected validation outcomes (valid/invalid) and verifies each fixture against its target schema, catching schema regressions early (`check-protocol-fixtures.ts:79-92`).
- **Recursive JSON discovery**: Both scripts use `listJsonFiles()` to recursively find all `.json` files in a directory tree (`generate-types.ts:24-29`, `check-protocol-fixtures.ts:33-38`).

## Key Types

### `check-protocol-fixtures.ts`

- `FixtureDefinition` (`check-protocol-fixtures.ts:8-12`) — `{ path: string; schema: string; valid: boolean }`. One fixture entry in the manifest.
- `FixtureManifest` (`check-protocol-fixtures.ts:14-16`) — `{ fixtures: FixtureDefinition[] }`. Top-level manifest shape.
- `SchemaDocument` (`check-protocol-fixtures.ts:18-21`) — `Record<string, unknown>` with optional `$id` and `$defs`.

### `generate-types.ts`

- `SchemaDocument` (`generate-types.ts:9-12`) — same shape as above; used for reading schema files.

## Key Functions

### `generate-types.ts`

- `readJson(path: string): SchemaDocument` (`generate-types.ts:20-22`) — reads and parses a JSON file.
- `listJsonFiles(directory: string): string[]` (`generate-types.ts:24-29`) — recursively lists all `.json` files in a directory tree.
- `toPascalCase(value: string): string` (`generate-types.ts:31-38`) — converts a schema file name or definition name to PascalCase (strips `.schema` suffix, splits on non-alphanumeric, capitalizes each part).
- `hasTopLevelContract(schema: SchemaDocument): boolean` (`generate-types.ts:40-42`) — checks if schema has `type`, `oneOf`, `anyOf`, `allOf`, or `$ref` at the top level (determines whether a type is generated for the file itself).
- `addGeneratedDefinition(name: string, reference: string): void` (`generate-types.ts:48-53`) — adds a `$ref`-based definition to the generated definitions map; throws on duplicate name.

### `check-protocol-fixtures.ts`

- `readJson(path: string): unknown` (`check-protocol-fixtures.ts:29-31`) — reads and parses a JSON file.
- `listJsonFiles(directory: string): string[]` (`check-protocol-fixtures.ts:33-38`) — recursively lists all `.json` files.
- `isFixtureManifest(value: unknown): value is FixtureManifest` (`check-protocol-fixtures.ts:40-46`) — type guard checking `fixtures` array presence.

## Data & Control Flow

### Type generation flow (`generate-types.ts`)

1. Resolve repository root from script location (`generate-types.ts:14`).
2. Set `schemasDirectory` to `packages/protocol/schemas/`, `outputPath` to `packages/protocol/src/generated.ts`.
3. `listJsonFiles(schemasDirectory)` finds all schema JSON files (`generate-types.ts:44`).
4. For each schema file:
   - Parse JSON via `readJson()`.
   - Validate `$id` exists and starts with `https://ide-bridge.dev/schemas/0.1.0/` (`generate-types.ts:56-61`). Throws if missing or unexpected.
   - Store in `schemasById` map keyed by `$id`.
   - If `hasTopLevelContract(schema)`, generate a top-level type from the file name (`generate-types.ts:65-68`).
   - For each key in `schema.$defs`, generate a type from the definition name (`generate-types.ts:70-72`).
5. Build `generationRoot` schema: `$schema: 2020-12`, `title: "IDEBPProtocolTypes"`, `definitions: generatedDefinitions` (`generate-types.ts:75-81`).
6. Configure `$refOptions` with custom `"idebp"` resolver:
   - `canRead`: matches `/^https:\/\/ide-bridge\.dev\/schemas\/0\.1\.0\//` (`generate-types.ts:87`).
   - `read(file)`: splits URL on `#`, looks up schema by ID in `schemasById`, returns stringified schema (`generate-types.ts:88-98`).
   - `http: false` — disables HTTP resolution (`generate-types.ts:100`).
7. `compile(generationRoot, "IDEBPProtocolTypes", options)` produces TypeScript source (`generate-types.ts:104-121`).
   - `customName` uses schema `title` or falls back to `toPascalCase(keyNameFromDefinition)`.
   - `declareExternallyReferenced: true` emits types for cross-schema references.
   - `enableConstEnums: false`, `strictIndexSignatures: false`, `unknownAny: true`, `unreachableDefinitions: true`.
8. Resolve Prettier config from output path, format generated code (`generate-types.ts:122-126`).
9. If `--check` flag: compare formatted output to existing file; throw if stale (`generate-types.ts:128-132`).
10. Otherwise: write formatted output to `generated.ts` and log schema count (`generate-types.ts:133-137`).

### Fixture validation flow (`check-protocol-fixtures.ts`)

1. Resolve repository root, set `schemasDirectory` and `fixturesDirectory` (`check-protocol-fixtures.ts:23-27`).
2. Create Ajv 2020-12 instance with `{ allErrors: true, strict: true }`, add formats (`check-protocol-fixtures.ts:48-49`).
3. Collect all JSON files from `schemasDirectory` and `fixturesDirectory/schemas/` (`check-protocol-fixtures.ts:52-55`).
4. For each schema file: parse JSON, `ajv.addSchema(schema)`, record `$id` and all `$defs` references in `schemaReferences` (`check-protocol-fixtures.ts:56-65`).
5. Verify every `schemaReference` resolves to a compiled validator (`check-protocol-fixtures.ts:67-71`). Throws if any cannot be compiled.
6. Read and validate `fixtures/manifest.json` via `isFixtureManifest()` (`check-protocol-fixtures.ts:73-76`). Throws if invalid shape.
7. For each fixture in manifest:
   - Look up validator by `fixture.schema` $ref (`check-protocol-fixtures.ts:80`).
   - If validator missing: record failure (`check-protocol-fixtures.ts:81-83`).
   - Read fixture JSON, validate against schema (`check-protocol-fixtures.ts:86`).
   - Compare actual validation result to expected `fixture.valid` (`check-protocol-fixtures.ts:87`).
   - If mismatch: record failure with Ajv error details (`check-protocol-fixtures.ts:88-90`).
8. If any failures: throw aggregated error with all failure messages (`check-protocol-fixtures.ts:94-96`).
9. Log success: compiled schema count + fixture count (`check-protocol-fixtures.ts:98-99`).

## Integration Points

- **Consumed by**: Root `package.json` npm scripts (`pnpm protocol:generate` → `generate-types.ts`, `pnpm protocol:check-fixtures` → `check-protocol-fixtures.ts`). Referenced in `AGENTS.md` §7 as `node scripts/check-protocol-fixtures.ts`.
- **Depends on**:
  - `ajv` (2020-12 via `ajv/dist/2020.js`) — schema compilation and validation in both scripts.
  - `ajv-formats` — format keyword support (both scripts).
  - `json-schema-to-typescript` — TypeScript type generation from JSON Schema (generate-types only).
  - `prettier` — code formatting of generated output (generate-types only).
  - Node.js built-ins: `node:fs`, `node:path`, `node:url`.
- **External boundaries**:
  - Schema input: `packages/protocol/schemas/**/*.schema.json` (canonical wire contract).
  - Fixture input: `packages/protocol/fixtures/manifest.json` + `packages/protocol/fixtures/**/*.json`.
  - Fixture schema input: `packages/protocol/fixtures/schemas/**/*.json`.
  - Generated output: `packages/protocol/src/generated.ts`.
  - Schema URI prefix: `https://ide-bridge.dev/schemas/0.1.0/` (validated in generate-types, used for $ref resolution).
  - `tsconfig.json` extends `../tsconfig.base.json` with `noEmit: true` (`tsconfig.json:1-6`).

## Common Gotchas

- **`generated.ts` must not be hand-edited.** The file header explicitly says `Do not edit this file manually` (`generated.ts:5`). Any schema change must go through `generate-types.ts`. CI uses `--check` to detect staleness (`generate-types.ts:128-132`).
- **`generate-types.ts` disables HTTP resolution.** The `$refOptions.resolve.http = false` setting (`generate-types.ts:100`) prevents the compiler from making network requests. All schema resolution happens in-memory via the custom `"idebp"` resolver. Do not re-enable HTTP.
- **Schema `$id` must start with the prefix.** `generate-types.ts` throws if a schema's `$id` does not start with `https://ide-bridge.dev/schemas/0.1.0/` (`generate-types.ts:59-61`). This prefix is hardcoded in `schemaIdPrefix` (`generate-types.ts:18`).
- **Duplicate generated type names throw.** `addGeneratedDefinition` throws if two schemas or definitions produce the same PascalCase name (`generate-types.ts:49-51`). This catches naming collisions early but means schema definition names must be unique across all schema files after PascalCase conversion.
- **Fixture manifest shape is strict.** `isFixtureManifest` checks for an object with a `fixtures` array (`check-protocol-fixtures.ts:40-46`). A malformed manifest throws immediately. Each fixture must have `path`, `schema`, and `valid` fields.
- **`check-protocol-fixtures.ts` validates all schema references compile.** After loading all schemas, it verifies every `$id` and `$defs` reference resolves (`check-protocol-fixtures.ts:67-71`). A missing $ref in any schema causes a hard failure before fixtures are even checked.
- **`toPascalCase` strips `.schema` from filenames.** The function removes the `.schema` suffix before PascalCase conversion (`generate-types.ts:32`). So `bridge-handshake-request.schema.json` becomes `BridgeHandshakeRequest`, not `BridgeHandshakeRequestSchema`.
- **`tsconfig.json` has `noEmit: true`.** The scripts tsconfig is for type-checking only; scripts are executed directly via `node` (with `--experimental-strip-types` or tsx), not compiled to JS (`tsconfig.json:4`).
