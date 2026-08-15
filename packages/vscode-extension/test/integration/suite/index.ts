/**
 * Mocha entry point loaded by VS Code inside the extension host.
 *
 * The suite is bundled into a single CommonJS file, so it registers its tests by importing them
 * directly instead of globbing a directory that does not exist at runtime.
 */

import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 180_000 });
  mocha.suite.emit("pre-require", globalThis, "e2e", mocha);
  await import("./e2e.test.js");

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${String(failures)} end-to-end test(s) failed`));
      else resolve();
    });
  });
}
