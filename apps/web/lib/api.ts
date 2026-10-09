/**
 * Route handler plumbing: validation, the error envelope, and tracing.
 *
 * Every handler goes through `route()`, which means every response carries a
 * correlation id, every unexpected failure is logged once with its stack and
 * returned as a stable code, and no handler has to remember to do either.
 */

import { logger, newCorrelationId, withCorrelation } from '@pmdash/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';

import { ApiError, type ErrorCode } from './errors';

const log = logger('api');

export type Handler<T> = (ctx: {
  request: NextRequest;
  params: Record<string, string>;
  correlationId: string;
}) => Promise<T>;

function envelope(
  code: ErrorCode,
  message: string,
  correlationId: string,
  status: number,
  details?: unknown,
) {
  return NextResponse.json(
    { error: { code, message, correlationId, ...(details === undefined ? {} : { details }) } },
    { status, headers: { 'x-correlation-id': correlationId } },
  );
}

/**
 * Wraps a handler.
 *
 * Catches three kinds of failure and treats them very differently:
 *
 *  - `ZodError` — the caller's input. Returned as 400 with field-level detail,
 *    because they can fix it.
 *  - `ApiError` — a rule this API enforces. Returned with its own code, since
 *    the message was written to be read.
 *  - anything else — ours. Logged with its stack, returned as a bare INTERNAL
 *    with the correlation id and nothing else. A raw Postgres error can carry
 *    a connection string or a column name; neither belongs in a response.
 */
export function route<T>(name: string, handler: Handler<T>) {
  return async (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();
    const params = await context.params;

    return withCorrelation({ correlationId, route: name }, async () => {
      const start = performance.now();
      try {
        const body = await handler({ request, params, correlationId });
        log.info('api_ok', {
          method: request.method,
          duration_ms: Math.round(performance.now() - start),
        });
        return NextResponse.json(body, { headers: { 'x-correlation-id': correlationId } });
      } catch (err) {
        const duration_ms = Math.round(performance.now() - start);

        if (err instanceof ZodError) {
          const details = Object.fromEntries(
            err.issues.map((i) => [i.path.join('.') || '_', i.message]),
          );
          log.warn('api_invalid', { method: request.method, duration_ms, details });
          return envelope(
            'VALIDATION_FAILED',
            'The request did not validate.',
            correlationId,
            400,
            details,
          );
        }

        if (err instanceof ApiError) {
          log.warn('api_rejected', { method: request.method, duration_ms, code: err.code });
          return envelope(err.code, err.message, correlationId, err.status, err.details);
        }

        log.error('api_failed', err, { method: request.method, duration_ms });
        return envelope(
          'INTERNAL',
          'Something went wrong. Quote the correlation id when reporting this.',
          correlationId,
          500,
        );
      }
    });
  };
}

/** Parses and validates a JSON body. Throws ZodError, which `route` renders. */
export async function parseBody<S extends ZodType>(
  request: NextRequest,
  schema: S,
): Promise<ReturnType<S['parse']>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // A malformed body is the caller's mistake, and saying so beats a 500.
    throw new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON.');
  }
  return schema.parse(raw) as ReturnType<S['parse']>;
}

/** Parses and validates a query string. */
export function parseQuery<S extends ZodType>(
  request: NextRequest,
  schema: S,
): ReturnType<S['parse']> {
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const all = request.nextUrl.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0]!;
  }
  return schema.parse(params) as ReturnType<S['parse']>;
}
