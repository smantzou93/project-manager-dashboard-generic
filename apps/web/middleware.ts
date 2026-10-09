import { NextResponse, type NextRequest } from 'next/server';

/**
 * Assigns a correlation id to every request.
 *
 * Runs on the edge runtime, where AsyncLocalStorage is unavailable, so this
 * does one job only: mint the id (or adopt an inbound one) and put it on both
 * the request and the response. Server components pick it up from the request
 * header and open the async context there; the response header is what lets a
 * user or an agent quote an id from a browser's network tab when reporting a
 * problem.
 *
 * An inbound id is honoured so a trace survives a hop from another service,
 * but it is sanitised first -- it ends up in log files that get grepped, and
 * an unvalidated header is not something to concatenate into them.
 */
const HEADER = 'x-correlation-id';
const SAFE = /^[A-Za-z0-9_-]{8,64}$/;

function mint(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function middleware(request: NextRequest) {
  const inbound = request.headers.get(HEADER);
  const correlationId = inbound && SAFE.test(inbound) ? inbound : mint();

  const headers = new Headers(request.headers);
  headers.set(HEADER, correlationId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(HEADER, correlationId);
  return response;
}

export const config = {
  // Static assets do not need a trace, and logging them drowns the signal.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
