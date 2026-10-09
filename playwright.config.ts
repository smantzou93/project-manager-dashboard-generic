import { defineConfig, devices } from '@playwright/test';

import { FIXTURE_PRESET, PINNED_NOW_ISO } from './tests/fixtures';

/**
 * Visual and end-to-end tests.
 *
 * Everything here exists to make the same commit produce the same pixels, on
 * this machine and on a CI runner, today and in a month. Anything left
 * non-deterministic becomes a permanently failing diff, and a suite that always
 * fails is a suite nobody reads.
 *
 * The clock is pinned on both sides. `PMDASH_SEED_NOW` fixes the instant the
 * fixture's dates are generated from; `PMDASH_AS_OF` fixes the instant the app
 * renders "as of". Pinning only the first is not enough -- the app would still
 * call now() and the fixture would age by a day every day.
 */

const PORT = Number(process.env.PMDASH_TEST_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // Screenshot comparison is order-independent but shares one app and one
  // database; parallel workers racing the same Postgres makes failures
  // non-reproducible, which defeats the purpose.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  /*
   * Baselines are stored per platform.
   *
   * Font rasterisation differs between macOS and Linux, so a baseline captured
   * on a laptop can never match a Linux runner -- the text antialiasing alone
   * is a few hundred differing pixels. Rather than pretend otherwise, each
   * platform keeps its own set and CI (Linux) is the authoritative one.
   */
  // A fixed path, not {testDir}: testDir widened to ./tests when the contract
  // suite was added, which silently moved every baseline and made the whole
  // visual suite look like it had never been run.
  snapshotPathTemplate: 'tests/visual/__baselines__/{platform}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      // A couple of stray antialiased pixels are not a regression; a changed
      // chart is thousands. This threshold distinguishes them without letting
      // a real change through.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },

  use: {
    baseURL: BASE_URL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    // A fractional device pixel ratio would resample text differently per
    // machine. 1 keeps the raster predictable.
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-GB',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      // Contract tests: spec-driven, no browser needed, so they run first and
      // fail fast when the API has drifted from its published document.
      name: 'api',
      testMatch: /tests\/api\/.*\.spec\.ts/,
      use: { baseURL: BASE_URL },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 1000 } },
      // Without this the desktop project also picks up the dark and mobile
      // specs and runs them in a light 1440px context, where they cannot pass.
      testMatch: /tests\/visual\/(dashboard|projects)\.spec\.ts/,
    },
    {
      name: 'dark',
      use: { colorScheme: 'dark', viewport: { width: 1440, height: 1000 } },
      testMatch: /tests\/visual\/theme\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], deviceScaleFactor: 1 },
      testMatch: /tests\/visual\/responsive\.spec\.ts/,
    },
  ],

  /*
   * Prepares the fixture and starts the app in one command.
   *
   * `dev.sh --pinned --seed-only` is reused rather than reimplemented, so the
   * suite boots the stack exactly the way a developer does -- including the
   * runtime check and the migration-ledger assertion. If the setup diverges,
   * the tests stop telling you anything about the real thing.
   */
  webServer: {
    command:
      `./scripts/dev.sh --yes --pinned --preset ${FIXTURE_PRESET} --seed-only && ` +
      `npx next dev apps/web -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PMDASH_AS_OF: PINNED_NOW_ISO, PMDASH_SEED_NOW: PINNED_NOW_ISO },
  },
});
