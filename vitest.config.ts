import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use projects configuration: each package has its own vitest.config.ts
    projects: ["packages/*/vitest.config.ts", "packages/*/vitest.config.mts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
