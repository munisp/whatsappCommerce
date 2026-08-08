import { defineConfig } from "vitest/config";

/**
 * E2E integration suite config — run with:
 *   pnpm exec vitest run --config tests/e2e/vitest.config.ts
 *
 * These tests talk to a LIVE docker-compose stack (see
 * tests/e2e/docker-compose.test.yml and scripts/run-e2e.sh). They share one
 * database and one stack, so files run sequentially in a single fork.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
