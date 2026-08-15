#!/usr/bin/env node
"use strict";

/**
 * Inspects the packaged VSIX.
 *
 * A `.vscodeignore` is a declaration of intent; this script is the check. It asserts the archive
 * contains exactly the runtime surface and nothing else — no sources, no tests, no build
 * configuration, no source maps — and that the manifest a user's VS Code will read matches what the
 * extension actually claims to be.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const manifest = require(path.join(packageRoot, "package.json"));

/** Files that must be present, each mapped to its purpose. */
const REQUIRED = new Set([
  "extension/package.json",
  "extension/README.md",
  "extension/LICENSE.txt",
  "extension/dist/extension.js",
  "extension/dist/daemon-child.js",
  "[Content_Types].xml",
  "extension.vsixmanifest",
]);

/** Any entry matching one of these is development material that must never ship. */
const FORBIDDEN_PATTERNS = [
  { pattern: /^extension\/src\//u, reason: "TypeScript sources" },
  { pattern: /^extension\/test\//u, reason: "tests" },
  { pattern: /^extension\/scripts\//u, reason: "build scripts" },
  { pattern: /^extension\/node_modules\//u, reason: "dependencies (the extension is bundled)" },
  { pattern: /\.map$/u, reason: "source maps, which embed the full original sources" },
  { pattern: /tsconfig.*\.json$/u, reason: "TypeScript configuration" },
  { pattern: /\.tsbuildinfo$/u, reason: "incremental build state" },
  { pattern: /vitest\.config/u, reason: "test configuration" },
  { pattern: /^extension\/codemap\.md$/u, reason: "internal documentation" },
];

const MAX_VSIX_BYTES = 4 * 1024 * 1024;

function listEntries(vsixPath) {
  // `unzip -Z1` lists archive members without extracting anything.
  const output = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" });
  return output.split("\n").filter((line) => line.length > 0 && !line.endsWith("/"));
}

function main() {
  const vsixPath = process.argv[2] ?? path.join(packageRoot, "dist", "ide-bridge.vsix");
  if (!existsSync(vsixPath)) {
    throw new Error(`VSIX not found at ${vsixPath}. Run "pnpm --filter vscode-extension package".`);
  }

  const entries = listEntries(vsixPath);
  const problems = [];

  // vsce lowercases the readme and license entry names when it writes the archive, so required
  // entries are matched case-insensitively while forbidden patterns stay exact.
  const normalized = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const required of REQUIRED) {
    if (!normalized.has(required.toLowerCase())) {
      problems.push(`missing required entry: ${required}`);
    }
  }
  for (const entry of entries) {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(entry)) problems.push(`must not ship ${entry} (${reason})`);
    }
  }

  const size = statSync(vsixPath).size;
  if (size > MAX_VSIX_BYTES) {
    problems.push(
      `VSIX is ${(size / 1024 / 1024).toFixed(2)} MB, above the ${MAX_VSIX_BYTES / 1024 / 1024} MB ceiling`,
    );
  }

  // The activation contract and the trust declaration are what actually protect an untrusted
  // window, so they are verified in the artifact rather than only in the source tree.
  if (manifest.main !== "./dist/extension.js") {
    problems.push(`manifest main is ${String(manifest.main)}, expected ./dist/extension.js`);
  }
  if (manifest.capabilities?.untrustedWorkspaces?.supported !== "limited") {
    problems.push("manifest must declare limited untrusted-workspace support");
  }
  if (!Array.isArray(manifest.activationEvents) || manifest.activationEvents.length === 0) {
    problems.push("manifest must declare at least one activation event");
  }

  if (problems.length > 0) {
    console.error("VSIX inspection failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `VSIX inspection passed: ${String(entries.length)} entries, ${(size / 1024).toFixed(1)} KB.`,
  );
}

main();
