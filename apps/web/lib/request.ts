/**
 * Server-side request context.
 *
 * `middleware.ts` mints the correlation id; this opens the async context so
 * that everything a page does -- including queries several layers down in
 * `packages/db` -- is logged against it without any of them taking a parameter
 * they do not otherwise need.
 *
 * Pages wrap their data fetching in `withRequest`. That is the one place it has
 * to be remembered, and a page that forgets still works: its queries log under
 * `no-request`, which is visible in the logs rather than silently wrong.
 */

import { logger, newCorrelationId, withCorrelation } from '@pmdash/logger';
import { headers } from 'next/headers';

const log = logger('web');

export async function correlationId(): Promise<string> {
  const h = await headers();
  return h.get('x-correlation-id') ?? newCorrelationId();
}

/**
 * Runs a page's data fetching inside a traced context, timing it and logging
 * a failure with its stack.
 *
 * The stack goes to the log and never to the browser. The user sees the
 * correlation id, which is what connects their screenshot to the log line
 * holding the detail.
 */
export async function withRequest<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const id = await correlationId();
  return withCorrelation({ correlationId: id, route }, async () => {
    const start = performance.now();
    try {
      const result = await fn();
      log.info('page_rendered', { duration_ms: Math.round(performance.now() - start) });
      return result;
    } catch (err) {
      log.error('page_failed', err, { duration_ms: Math.round(performance.now() - start) });
      throw err;
    }
  });
}
