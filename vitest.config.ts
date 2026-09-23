import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use projects configuration: each package has its own vitest.config.ts
    projects: [
      "packages/*/vitest.config.ts",
      "packages/*/vitest.config.mts",
      // The gate installed into the agent hosts: shipped with every release, so tested with it.
      "integrations/agent-hosts/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
