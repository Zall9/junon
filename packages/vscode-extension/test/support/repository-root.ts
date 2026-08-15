import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Locates the repository root by walking up for the workspace marker.
 *
 * This package compiles as CommonJS, so `import.meta.url` is unavailable, and `process.cwd()`
 * differs between a filtered run and a run from the repository root. Ascending to a known marker
 * works in both.
 */
export function repositoryRoot(): string {
  let directory = process.cwd();
  for (;;) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Could not locate the repository root");
    directory = parent;
  }
}
