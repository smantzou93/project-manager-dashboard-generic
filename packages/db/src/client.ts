/**
 * Database client.
 *
 * The connection is cached on `globalThis` because Next.js re-evaluates modules
 * on every hot reload in development. Without the cache, each save would open a
 * fresh pool and the database would hit max_connections within a few minutes of
 * editing.
 */

import { logger } from '@pmdash/logger';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

const log = logger('db');

/**
 * Queries slower than this are logged individually.
 *
 * Matches `log_min_duration_statement=200` in docker-compose.yml on purpose:
 * Postgres and the application agree on what "slow" means, so a statement
 * flagged by one is findable in the other by correlation id.
 */
const SLOW_QUERY_MS = Number(process.env.PMD_SLOW_QUERY_MS ?? 200);

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
      log.debug('pg_notice', { message: notice.message });
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
/*
 * `Reflect.get` and `Reflect.apply` are typed `any` by definition -- a proxy
 * trap cannot know the shape of what it forwards. The exported constants are
 * typed via the Proxy target, so callers still get full type information; the
 * `any` exists only inside these four lines. Disabled narrowly rather than
 * repository-wide, which is the point of doing it here.
 */
/* eslint-disable @typescript-eslint/no-unsafe-return */
export const db = new Proxy({} as CachedConnection['db'], {
  get: (_t, prop, receiver) => Reflect.get(connection().db, prop, receiver),
  has: (_t, prop) => prop in connection().db,
});

/**
 * Raw postgres.js tag, for the window-function heavy metric queries.
 *
 * Needs both traps: a tagged template hits `apply`, while `sql.end()` and
 * `sql.unsafe()` hit `get`.
 *
 * Note for callers: pass dates through `ts()` from queries/scope.ts, not as
 * bare Date objects. `drizzle()` mutates this instance's type serializers, so
 * raw Date binding throws. The helper's docstring has the detail.
 */
export const sql = new Proxy((() => {}) as unknown as CachedConnection['sql'], {
  apply: (_t, thisArg, args: Parameters<CachedConnection['sql']>) => {
    const query = Reflect.apply(connection().sql, thisArg, args) as unknown;
    return instrument(query, args[0]);
  },
  get: (_t, prop, receiver) => Reflect.get(connection().sql, prop, receiver),
  has: (_t, prop) => prop in connection().sql,
});
/* eslint-enable @typescript-eslint/no-unsafe-return */

/**
 * Wraps a postgres.js query so a slow one is reported with its correlation id.
 *
 * The query TEXT is logged, never the interpolated parameters: a parameter can
 * be a project name, a person's name, or anything else a user typed, and this
 * repository is public while the logs are not. The template strings are static
 * source, so they are safe and are what identifies the query anyway.
 *
 * Queries are thenables rather than promises in postgres.js, and they are lazy:
 * attaching `.then` here would execute every one, including fragments composed
 * into a larger statement. So only an object that is actually awaited gets
 * instrumented, by wrapping `then` rather than calling it.
 */
function instrument(query: unknown, strings: unknown): unknown {
  if (
    query === null ||
    typeof query !== 'object' ||
    typeof (query as PromiseLike<unknown>).then !== 'function' ||
    !Array.isArray(strings)
  ) {
    return query;
  }

  const name = queryName(strings as readonly string[]);
  const original = (query as { then: PromiseLike<unknown>['then'] }).then.bind(query);
  let started: number | null = null;

  (query as { then: PromiseLike<unknown>['then'] }).then = ((onOk, onErr) => {
    started ??= performance.now();
    return original(
      (value: unknown) => {
        const ms = Math.round(performance.now() - started!);
        if (ms >= SLOW_QUERY_MS) log.warn('slow_query', { query: name, duration_ms: ms });
        return onOk ? onOk(value) : value;
      },
      (err: unknown) => {
        log.error('query_failed', err, {
          query: name,
          duration_ms: Math.round(performance.now() - started!),
        });
        if (onErr) return onErr(err);
        throw err;
      },
    );
  }) as PromiseLike<unknown>['then'];

  return query;
}

/** First meaningful clause of a statement, for identifying it in a log. */
function queryName(strings: readonly string[]): string {
  const text = strings.join(' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 120);
}

/** True once a connection has actually been opened. Lets teardown skip a no-op. */
export const isConnected = () => globalForDb.__pmdash !== undefined;

export { schema };
