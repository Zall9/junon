/**
 * Launches a real VS Code, installs this extension into it, and runs the end-to-end suite.
 *
 * The window opens the deterministic TypeScript fixture project. The rename scenario writes to those
 * files, so the launcher restores them afterwards: the fixture is a committed contract, not scratch
 * space, and a test run must leave it exactly as it found it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

// Bundled to dist-test/run-integration.js, so the package root is one level up.
const packageRoot = resolve(__dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const fixtureProject = resolve(repositoryRoot, "examples/typescript-project");

/** Files the rename scenario modifies, captured before the run and restored after it. */
const MUTATED_FIXTURE_FILES = ["src/circle.ts", "src/index.ts", "tests/circle.test.ts"] as const;

function snapshotFixture(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const relative of MUTATED_FIXTURE_FILES) {
    const filePath = resolve(fixtureProject, relative);
    snapshot.set(filePath, readFileSync(filePath, "utf8"));
  }
  return snapshot;
}

function restoreFixture(snapshot: Map<string, string>): void {
  for (const [filePath, contents] of snapshot) {
    if (readFileSync(filePath, "utf8") !== contents) writeFileSync(filePath, contents);
  }
}

/**
 * Writes the sandbox's own settings, so every run is the run everyone else gets.
 *
 * `ideBridge.logLevel` is `debug` because a dropped notification is logged at that level, and a
 * dropped notification is exactly the failure this suite exists to catch. Written here rather than
 * left in the sandbox by hand: a settings file that only exists on one machine makes that machine's
 * run different from everyone else's, which is the shape of the defect that cost this project three
 * days (ADR-0037).
 */
function writeSandboxSettings(userDataDirectory: string): void {
  const userDirectory = resolve(userDataDirectory, "User");
  mkdirSync(userDirectory, { recursive: true });
  writeFileSync(
    resolve(userDirectory, "settings.json"),
    `${JSON.stringify({ "ideBridge.logLevel": "debug" }, undefined, 2)}\n`,
  );
}

/**
 * Resolves the executable to launch.
 *
 * `@vscode/test-electron` 2.5.2 derives the macOS binary as `Contents/MacOS/Electron`, but current
 * stable builds ship it as `Contents/MacOS/Code`. The download itself is fine, so the archive is
 * reused and only the executable path is corrected when the expected one is absent.
 */
async function resolveExecutable(): Promise<string> {
  const downloaded = await downloadAndUnzipVSCode();
  if (existsSync(downloaded)) return downloaded;
  const corrected = downloaded.replace(/\/Contents\/MacOS\/Electron$/u, "/Contents/MacOS/Code");
  if (corrected !== downloaded && existsSync(corrected)) return corrected;
  throw new Error(`No VS Code executable found at ${downloaded} or ${corrected}`);
}

async function main(): Promise<void> {
  const snapshot = snapshotFixture();
  const userDataDirectory = resolve(packageRoot, ".vscode-test/user-data");
  writeSandboxSettings(userDataDirectory);
  try {
    await runTests({
      vscodeExecutablePath: await resolveExecutable(),
      extensionDevelopmentPath: packageRoot,
      extensionTestsPath: resolve(packageRoot, "dist-test/suite/index.js"),
      launchArgs: [
        fixtureProject,
        // A test window must not inherit the developer's installed extensions or settings.
        "--disable-extensions",
        "--disable-workspace-trust",
        "--user-data-dir",
        userDataDirectory,
        "--disable-gpu",
        // The extension logs a dropped notification at debug level, and a dropped notification is
        // exactly the kind of failure this suite exists to catch. Without this the window's log
        // level would silence it and the run would look clean while losing events.
        "--log",
        "debug",
      ],
      extensionTestsEnv: {
        // Keep the daemon's discovery file inside the test sandbox. This was dead configuration
        // until 2026-08-14 — the extension read an empty `ideBridge.discoveryFile` setting as a
        // configured path and never consulted the variable, so both sides attached to the shared
        // file under $HOME and the suite tested whatever daemon happened to be running (ADR-0037).
        IDE_BRIDGE_DISCOVERY_FILE: resolve(packageRoot, ".vscode-test/discovery.json"),
      },
    });
  } finally {
    restoreFixture(snapshot);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
