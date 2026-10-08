/**
 * Database client.
 *
 * The connection is cached on `globalThis` because Next.js re-evaluates modules
 * on every hot reload in development. Without the cache, each save would open a
 * fresh pool and the database would hit max_connections within a few minutes of
 * editing.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run ./scripts/preflight.sh to generate .env, ' +
        'then ./scripts/dev.sh to start the database.',
    );
  }
  return url;
}

type CachedConnection = {
  sql: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const globalForDb = globalThis as unknown as { __pmdash?: CachedConnection };

function createConnection(): CachedConnection {
  const sql = postgres(requireDatabaseUrl(), {
    // Dev pools stay small; the dashboard is read-heavy and mostly aggregates.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    // Surface slow or failing statements through the shared logger rather than
    // letting postgres.js write straight to stdout.
    onnotice: (notice) => {
      if (process.env.LOG_LEVEL === 'debug') console.warn('[db:notice]', notice.message);
    },
  });

  return { sql, db: drizzle(sql, { schema }) };
}

const connection = globalForDb.__pmdash ?? createConnection();
if (process.env.NODE_ENV !== 'production') globalForDb.__pmdash = connection;

/** Drizzle handle. Prefer this over raw SQL for anything the query builder covers. */
export const db = connection.db;

/** Raw postgres.js tag, for the window-function heavy metric queries. */
export const sql = connection.sql;

export { schema };
