import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface ExpectedSymbol {
  name: string;
  uri: string;
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface LanguageExpectedContract {
  language: string;
  symbols: ExpectedSymbol[];
  rename: {
    affectedUris: string[];
    untouchedUris: string[];
  };
}

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(protocolDirectory, "..", "..");
const fixtureDirectory = join(protocolDirectory, "fixtures", "languages");
const workspaceUriPrefix = "file:///workspace/";

function readContract(language: string): LanguageExpectedContract {
  return JSON.parse(
    readFileSync(join(fixtureDirectory, `${language}.expected.json`), "utf8"),
  ) as LanguageExpectedContract;
}

function repositoryPath(uri: string): string {
  if (!uri.startsWith(workspaceUriPrefix)) throw new Error(`Unexpected fixture URI: ${uri}`);
  const path = resolve(repositoryRoot, decodeURIComponent(uri.slice(workspaceUriPrefix.length)));
  if (!path.startsWith(`${repositoryRoot}/`))
    throw new Error(`Fixture URI escapes repository: ${uri}`);
  return path;
}

describe("deterministic language expected contracts", () => {
  for (const language of ["typescript", "java", "php"]) {
    it(`${language} symbol ranges and rename paths match real source files`, () => {
      const contract = readContract(language);
      expect(contract.language).toBe(language);

      for (const symbol of contract.symbols) {
        const source = readFileSync(repositoryPath(symbol.uri), "utf8");
        const lines = source.split(/\r?\n/u);
        const { start, end } = symbol.selectionRange;
        expect(start.line, symbol.uri).toBe(end.line);
        expect(lines[start.line]?.slice(start.character, end.character), symbol.uri).toBe(
          symbol.name,
        );
      }

      for (const uri of [...contract.rename.affectedUris, ...contract.rename.untouchedUris]) {
        expect(existsSync(repositoryPath(uri)), uri).toBe(true);
      }
    });
  }
});
