import { describe, it, expect } from "vitest";
// Import Ajv2020 from the 2020-12 distribution entry point.
// This verifies the proposed baseline (R3: ajv/dist/2020.js import path).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Phase 0 smoke test: verify Ajv 2020-12 instantiation and schema validation.
 *
 * This test confirms:
 * 1. The `ajv/dist/2020.js` import path resolves correctly (R3 risk mitigation).
 * 2. Ajv2020 can compile and validate a JSON Schema 2020-12 schema.
 * 3. Valid data passes validation.
 * 4. Invalid data fails validation with meaningful errors.
 * 5. 2020-12-specific features (e.g., prefixItems) work.
 */
describe("Ajv 2020-12 smoke test", () => {
  it("should instantiate Ajv2020 from ajv/dist/2020.js", () => {
    const ajv = new Ajv2020({ allErrors: true });
    expect(ajv).toBeDefined();
  });

  it("should validate a simple 2020-12 schema with valid data", () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);

    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        protocolVersion: {
          type: "string",
          pattern: "^\\d+\\.\\d+\\.\\d+$",
        },
        endpoint: {
          type: "string",
          format: "uri",
        },
      },
      required: ["protocolVersion", "endpoint"],
      additionalProperties: false,
    } as const;

    const validate = ajv.compile(schema);

    const validData = {
      protocolVersion: "0.1.0",
      endpoint: "ws://127.0.0.1:41731/rpc",
    };

    expect(validate(validData)).toBe(true);
  });

  it("should reject invalid data with meaningful errors", () => {
    const ajv = new Ajv2020({ allErrors: true });

    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        protocolVersion: {
          type: "string",
          pattern: "^\\d+\\.\\d+\\.\\d+$",
        },
      },
      required: ["protocolVersion"],
      additionalProperties: false,
    } as const;

    const validate = ajv.compile(schema);

    // Wrong pattern
    expect(validate({ protocolVersion: "not-a-version" })).toBe(false);
    expect(validate.errors).not.toBeNull();
    expect(validate.errors!.length).toBeGreaterThan(0);

    // Missing required field
    expect(validate({})).toBe(false);

    // Additional property (forbidden by additionalProperties: false)
    expect(validate({ protocolVersion: "0.1.0", extra: true })).toBe(false);
  });

  it("should support 2020-12 prefixItems (tuple validation)", () => {
    const ajv = new Ajv2020({ allErrors: true });

    // prefixItems is a 2020-12 feature that does not exist in draft-07
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    } as const;

    const validate = ajv.compile(schema);

    // Valid: matches prefixItems exactly, no extra items
    expect(validate(["hello", 42])).toBe(true);

    // Invalid: wrong type in first position
    expect(validate([123, 42])).toBe(false);

    // Invalid: extra item (items: false disallows)
    expect(validate(["hello", 42, "extra"])).toBe(false);
  });

  it("should support format validation via ajv-formats", () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);

    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        uri: { type: "string", format: "uri" },
      },
      required: ["uri"],
    } as const;

    const validate = ajv.compile(schema);

    expect(validate({ uri: "file:///home/user/project/src/service.ts" })).toBe(true);
    expect(validate({ uri: "not-a-uri" })).toBe(false);
  });
});
