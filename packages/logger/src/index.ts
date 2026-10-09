/**
 * Structured logging, shared by every TypeScript tier.
 *
 * One line-delimited JSON object per event, with the same field names the
 * Python importer emits, so a single correlation id reconstructs a whole
 * operation across web, api, db and ingestion:
 *
 *     jq 'select(.correlation_id=="a1b2c3")' logs/*.log
 *
 * That is the entire point. A log that cannot be correlated across tiers is
 * not much better than no log when the question is "what happened to this
 * request".
 *
 * The correlation id lives in AsyncLocalStorage rather than being threaded
 * through every function signature. Threading it means the query layer takes a
 * parameter it does not use, and one forgotten hand-off silently breaks the
 * trace — which you discover while debugging something else.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { redact } from './redact';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Tier = 'web' | 'api' | 'db' | 'ingestion';

export type LogRecord = {
  ts: string;
  level: Level;
  tier: Tier;
  event: string;
  correlation_id: string;
  duration_ms?: number;
  error?: unknown;
  [key: string]: unknown;
};

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): number {
  const name = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[name] ?? LEVELS.info;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

type Context = { correlationId: string; route?: string };

const storage = new AsyncLocalStorage<Context>();

/**
 * Runs `fn` with a correlation id attached to everything it does, however
 * deeply nested.
 */
export function withCorrelation<T>(ctx: Context, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The current correlation id, or a marker.
 *
 * `no-request` rather than throwing or inventing one: a query run from a
 * script or a test genuinely has no request, and that is worth being able to
 * see in the logs rather than papering over.
 */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? 'no-request';
}

export function currentRoute(): string | undefined {
  return storage.getStore()?.route;
}

/** 16 hex characters: short enough to paste into an issue, long enough to be unique. */
export function newCorrelationId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

const LOG_DIR = process.env.PMD_LOG_DIR ?? 'logs';
let dirReady = false;

function writeLine(tier: Tier, line: string): void {
  // stdout always: `dev.sh` and a container both read it there.
  process.stdout.write(line + '\n');

  if (process.env.PMD_LOG_TO_FILE === '0') return;
  try {
    if (!dirReady) {
      mkdirSync(LOG_DIR, { recursive: true });
      dirReady = true;
    }
    appendFileSync(join(LOG_DIR, `${tier}.log`), line + '\n');
  } catch {
    // A read-only filesystem must never take the app down. stdout is enough.
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  constructor(private readonly tier: Tier) {}

  private emit(level: Level, event: string, ctx: Record<string, unknown> = {}): void {
    if (LEVELS[level] < configuredLevel()) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      tier: this.tier,
      event,
      correlation_id: currentCorrelationId(),
      ...(currentRoute() ? { route: currentRoute() } : {}),
      ...(redact(ctx) as Record<string, unknown>),
    };

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // A value that will not serialise (a cycle, a BigInt) must not throw
      // from inside a logger and take down the request it was describing.
      line = JSON.stringify({
        ts: record.ts,
        level: 'warn',
        tier: this.tier,
        event: 'log_serialisation_failed',
        correlation_id: record.correlation_id,
        original_event: event,
      });
    }
    writeLine(this.tier, line);
  }

  debug = (event: string, ctx?: Record<string, unknown>) => this.emit('debug', event, ctx);
  info = (event: string, ctx?: Record<string, unknown>) => this.emit('info', event, ctx);
  warn = (event: string, ctx?: Record<string, unknown>) => this.emit('warn', event, ctx);

  /**
   * Logs an error with its message and stack.
   *
   * The stack goes to the log, never to a response. The client gets the
   * correlation id and a stable error code; this repository is public and the
   * logs are not. See the error envelope in issue #23.
   */
  error(event: string, err: unknown, ctx: Record<string, unknown> = {}): void {
    this.emit('error', event, {
      ...ctx,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  /** Times an async operation and logs it once, whether it succeeds or throws. */
  async time<T>(
    event: string,
    fn: () => Promise<T>,
    ctx: Record<string, unknown> = {},
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.emit('info', event, { ...ctx, duration_ms: Math.round(performance.now() - start) });
      return result;
    } catch (err) {
      this.error(event, err, { ...ctx, duration_ms: Math.round(performance.now() - start) });
      throw err;
    }
  }
}

const cache = new Map<Tier, Logger>();

/** One logger per tier, cached so hot reload does not accumulate them. */
export function logger(tier: Tier): Logger {
  let found = cache.get(tier);
  if (!found) {
    found = new Logger(tier);
    cache.set(tier, found);
  }
  return found;
}

export { redact } from './redact';
