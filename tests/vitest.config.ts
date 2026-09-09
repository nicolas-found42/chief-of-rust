import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: {
    alias: {
      "@chief-of-staff-demo/shared": fileURLToPath(
        new URL("../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/src/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["apps/server/src/**/*.ts"],
      exclude: [
        // The bootstrap runs only in Playwright's separate server process, so
        // its execution cannot reach the unit suite's V8 report.
        "apps/server/src/main.ts",
        // This is the hermetic e2e seam, registered only with ENABLE_TEST_SEED=1;
        // zero unit coverage here is by design.
        "apps/server/src/api/testSeed.ts",
      ],
      reporter: ["text", ["text-summary", { file: "coverage-summary.txt" }], "json-summary"],
      // Floors sit just under the measured totals; raise them when a change
      // moves the real number up. Measured 2026-09-05: lines 85.97,
      // statements 83.64, functions 85.98, branches 73.49.
      thresholds: { lines: 85.5, statements: 83, functions: 85.5, branches: 73 },
    },
  },
});
