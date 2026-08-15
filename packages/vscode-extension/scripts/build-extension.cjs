const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const { basename, dirname, resolve } = require("node:path");

const { buildSync } = require("esbuild");

const packageRoot = resolve(__dirname, "..");
const outputDirectory = resolve(packageRoot, "dist");
if (dirname(outputDirectory) !== packageRoot || basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected extension output directory");
}

rmSync(outputDirectory, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "--project",
    resolve(packageRoot, "tsconfig.json"),
    "--emitDeclarationOnly",
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

buildSync({
  entryPoints: {
    extension: resolve(packageRoot, "src/extension.ts"),
    "daemon-child": resolve(packageRoot, "src/daemon-child.ts"),
  },
  outdir: outputDirectory,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["vscode"],
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
});
