/**
 * Global setup for the integration suite.
 *
 * Asserts the database is reachable and holds the deterministic fixture. It
 * deliberately does NOT seed. Re-seeding on every run would destroy whatever
 * the developer was looking at, and a suite that quietly reshapes its own
 * fixture until the assertions pass has stopped being a test.
 *
 * So it checks, and on a mismatch fails with the exact command to fix it. Every
 * number the suite asserts is only meaningful for one preset seeded at one
 * instant, which is why both are recorded in `app_settings` by the seed and
 * verified here.
 */

import { config as loadEnv } from 'dotenv';

import { FIXTURE_PRESET, PINNED_NOW, PINNED_NOW_ISO } from '../fixtures.js';

const SEED_CMD = `./scripts/dev.sh --pinned --preset ${FIXTURE_PRESET} --seed-only`;

function fail(problem: string, cause?: unknown): never {
  throw new Error(
    `\n\nIntegration fixture is not ready: ${problem}\n\n` +
      `  Fix with:  ${SEED_CMD}\n\n` +
      `These tests assert exact metric values, which only hold for the\n` +
      `'${FIXTURE_PRESET}' preset seeded with the clock pinned to ${PINNED_NOW_ISO}.\n`,
    cause === undefined ? undefined : { cause },
  );
}

export async function setup() {
  loadEnv({ path: new URL('../../.env', import.meta.url).pathname });

  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is unset (no .env). Run ./scripts/preflight.sh first');
  }

  // Imported here, after loadEnv, so the lazy client sees DATABASE_URL.
  const { sql } = await import('../../packages/db/src/client.js');

  let settings: { key: string; value: unknown }[];
  try {
    settings = await sql<{ key: string; value: unknown }[]>`
      select key, value from app_settings
      where key in ('seed_clock', 'seed_clock_pinned', 'seed_preset')
    `;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sql.end({ timeout: 5 }).catch(() => {});
    if (/password authentication failed/i.test(msg)) {
      throw new Error(
        `\n\nPostgres rejected the password in .env.\n\n` +
          `  This usually means .env was regenerated after the volume was created.\n` +
          `  Postgres only reads POSTGRES_PASSWORD at initdb, so the existing\n` +
          `  volume still expects the old one.\n\n` +
          `  Fix with:  ./scripts/db-reset.sh --yes --volume\n`,
        // Keep the driver error reachable: the guidance above is a guess from a
        // message match, and if the guess is wrong the original is what helps.
        { cause: error },
      );
    }
    fail(`cannot query the database (${msg})`, error);
  }

  const get = (k: string) => settings.find((s) => s.key === k)?.value;

  if (settings.length === 0) fail('the database has no seed provenance recorded');
  if (get('seed_preset') !== FIXTURE_PRESET) {
    fail(`seeded with preset '${String(get('seed_preset'))}', expected '${FIXTURE_PRESET}'`);
  }
  if (get('seed_clock_pinned') !== true) {
    fail('seeded with a live clock, so every date differs from the expected fixture');
  }
  const clock = get('seed_clock');
  if (typeof clock !== 'string' || new Date(clock).toISOString() !== PINNED_NOW.toISOString()) {
    fail(`seeded at ${String(clock)}, expected ${PINNED_NOW_ISO}`);
  }
}

export async function teardown() {
  const { sql, isConnected } = await import('../../packages/db/src/client.js');
  if (isConnected()) await sql.end({ timeout: 5 }).catch(() => {});
}
