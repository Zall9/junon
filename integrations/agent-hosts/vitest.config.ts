import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent-hosts",
    environment: "node",
    include: ["opencode/**/*.test.ts"],
  },
});
