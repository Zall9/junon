const { rmSync } = require("node:fs");
const { basename, dirname, resolve } = require("node:path");

const { buildSync } = require("esbuild");

/**
 * Bundles the extension-host test suite the same way the extension itself is bundled.
 *
 * The suite runs inside VS Code's extension host, where workspace package resolution is not
 * available, so it is compiled into one self-contained CommonJS file with `vscode` left external.
 */

const packageRoot = resolve(__dirname, "..");
const outputDirectory = resolve(packageRoot, "dist-test");
if (dirname(outputDirectory) !== packageRoot || basename(outputDirectory) !== "dist-test") {
  throw new Error("Refusing to clean an unexpected integration output directory");
}

rmSync(outputDirectory, { recursive: true, force: true });

buildSync({
  entryPoints: {
    "suite/index": resolve(packageRoot, "test/integration/suite/index.ts"),
    "run-integration": resolve(packageRoot, "test/integration/run-integration.ts"),
  },
  outdir: outputDirectory,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["vscode", "@vscode/test-electron"],
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
});
