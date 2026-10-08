import { defineConfig } from 'vitest/config';

/**
 * Two suites, split by what they need to run.
 *
 * `unit` is pure computation -- forecasting, risk scoring, label fallbacks. No
 * database, no browser, runs in well under a second, so the pre-commit hook can
 * afford it.
 *
 * `integration` asserts the SQL metric definitions against a seeded database.
 * It needs Postgres running and the deterministic seed applied with a pinned
 * clock (see tests/integration/setup.ts), which is why it is not in pre-commit:
 * a hook that boots Docker gets bypassed with --no-verify inside a day.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/setup.ts'],
          // Metric queries hit the same small pool; running files in parallel
          // just queues them behind each other and muddies failure output.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
