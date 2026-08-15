import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // test/integration runs inside a real VS Code extension host under mocha
    // ("pnpm test:integration"); Vitest cannot load it and must not try.
    exclude: ["test/integration/**"],
  },
});
