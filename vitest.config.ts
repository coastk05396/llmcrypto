import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { ALLOW_TEST_COMPONENTS: "true" },
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    // Each integration file creates an embedded PostgreSQL instance. Keep memory bounded on local machines.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
