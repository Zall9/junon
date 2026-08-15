const { execFile } = require("node:child_process");
const { access, readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function main() {
  const packagePath = resolve(__dirname, "../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    throw new Error("VS Code extension name must be an unscoped lowercase identifier");
  }
  if (typeof manifest.publisher !== "string" || manifest.publisher.length === 0) {
    throw new Error("VS Code extension manifest must declare a publisher");
  }
  if (manifest.type !== "commonjs") {
    throw new Error("VS Code desktop extension output must be declared as CommonJS");
  }
  if (typeof manifest.main !== "string" || manifest.main.length === 0) {
    throw new Error("VS Code extension manifest must declare a main entry point");
  }
  if (!Array.isArray(manifest.activationEvents) || manifest.activationEvents.length === 0) {
    throw new Error("VS Code extension manifest must declare an activation event");
  }
  if (!Array.isArray(manifest.extensionKind) || !manifest.extensionKind.includes("workspace")) {
    throw new Error("IDE Bridge must run as a VS Code workspace extension");
  }
  if (manifest.capabilities?.untrustedWorkspaces?.supported !== "limited") {
    throw new Error("IDE Bridge must declare limited untrusted-workspace support");
  }
  const entryPath = resolve(__dirname, "..", manifest.main);
  const daemonChildPath = resolve(__dirname, "../dist/daemon-child.js");
  await Promise.all([access(entryPath), access(daemonChildPath)]);
  const [entrySource, daemonChildSource] = await Promise.all([
    readFile(entryPath, "utf8"),
    readFile(daemonChildPath, "utf8"),
  ]);
  if (/require\(["']@ide-bridge\//u.test(`${entrySource}\n${daemonChildSource}`)) {
    throw new Error("VS Code extension bundle contains an external IDE Bridge runtime dependency");
  }
  const smoke = await execFileAsync(process.execPath, [daemonChildPath, "--help"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 5_000,
  });
  if (!smoke.stdout.startsWith("Usage: ide-bridge") || smoke.stderr !== "") {
    throw new Error("Bundled daemon child smoke check failed");
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Extension build check failed"}\n`,
  );
  process.exitCode = 1;
});
