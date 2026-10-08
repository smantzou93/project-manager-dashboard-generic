/**
 * Applies pending SQL migrations, then exits.
 *
 * Run via `npm run db:migrate`. ./scripts/dev.sh calls this on every boot, so it
 * must be safe to run when there is nothing to do.
 */

import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run ./scripts/preflight.sh first.');
  process.exit(1);
}

// max: 1 because migrations must run serially on one connection; a pool would
// let DDL interleave and deadlock against itself.
//
// onnotice is silenced because Drizzle bootstraps its own ledger with
// CREATE ... IF NOT EXISTS, and Postgres emits a NOTICE each time it skips.
// Printed raw those look like failures in CI logs; real problems still throw.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const start = Date.now();
  await migrate(drizzle(sql), {
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  console.log(`migrations applied in ${Date.now() - start}ms`);
  await sql.end();
  process.exit(0);
} catch (error) {
  console.error('migration failed:', error instanceof Error ? error.message : error);
  await sql.end({ timeout: 5 });
  process.exit(1);
}
