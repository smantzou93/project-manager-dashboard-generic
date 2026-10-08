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

/**
 * Resolved on first use, never at import time.
 *
 * Connecting eagerly at module scope meant that importing *anything* from this
 * package -- including pure functions like `riskScore` and `forecastFromBurnup`
 * that never touch Postgres -- threw unless DATABASE_URL was set. That broke
 * unit tests, and would equally break any build-time or static context that
 * imports a type or a helper from here.
 */
function connection(): CachedConnection {
  const existing = globalForDb.__pmdash;
  if (existing) return existing;
  const created = createConnection();
  // Cache in every environment: the comment above about hot reload applies in
  // development, and in production one pool per process is simply correct.
  globalForDb.__pmdash = created;
  return created;
}

/**
 * Drizzle handle. Prefer this over raw SQL for anything the query builder
 * covers. Proxied so the connection opens on first property access.
 */
export const db = new Proxy({} as CachedConnection['db'], {
  get: (_t, prop, receiver) => Reflect.get(connection().db, prop, receiver),
  has: (_t, prop) => prop in connection().db,
});

/**
 * Raw postgres.js tag, for the window-function heavy metric queries.
 *
 * Needs both traps: `sql\`select 1\`` hits `apply`, while `sql.end()` and
 * `sql.unsafe()` hit `get`.
 */
export const sql = new Proxy((() => {}) as unknown as CachedConnection['sql'], {
  apply: (_t, thisArg, args: Parameters<CachedConnection['sql']>) =>
    Reflect.apply(connection().sql, thisArg, args),
  get: (_t, prop, receiver) => Reflect.get(connection().sql, prop, receiver),
  has: (_t, prop) => prop in connection().sql,
});

/** True once a connection has actually been opened. Lets teardown skip a no-op. */
export const isConnected = () => globalForDb.__pmdash !== undefined;

export { schema };
