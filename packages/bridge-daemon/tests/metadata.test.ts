import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DAEMON_VERSION } from "../src/metadata.js";

/**
 * One version, declared once.
 *
 * Six copies of this number existed and no two agreed — the daemon said 0.0.0, the plugin 0.1.0,
 * JUNON sent 0.1.0 from a package calling itself 0.0.0. Nothing could be compared to anything,
 * which is exactly why no update signal was possible: an IDE decides whether an update exists by
 * comparing version strings, and a string nobody maintains compares to nothing.
 *
 * The copies stay, because Gradle, npm and pip each want the number in their own file at build
 * time. What changes is that a copy drifting now fails a test instead of being discovered by a
 * user whose plugin never offered to update.
 */
describe("the declared version", () => {
  const repositoryVersion = readFileSync(
    join(import.meta.dirname, "../../../VERSION"),
    "utf8",
  ).trim();

  it("matches the repository's VERSION file", () => {
    expect(DAEMON_VERSION).toBe(repositoryVersion);
  });

  it("is a plain release number, with nothing an IDE cannot order", () => {
    // `0.1.0-SNAPSHOT` was what the plugin built as, and a suffix like that makes "is there a newer
    // one" unanswerable for the JetBrains update mechanism.
    expect(repositoryVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
