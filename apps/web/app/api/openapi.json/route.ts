import { NextResponse } from 'next/server';

import { openApiDocument } from '../../../lib/openapi';

/**
 * GET /api/openapi.json
 *
 * The machine-readable contract. Point a client generator at it, or feed it to
 * an agent that needs to drive this API without reading the source.
 */
export const dynamic = 'force-static';

export function GET() {
  return NextResponse.json(openApiDocument(), {
    headers: { 'cache-control': 'public, max-age=60' },
  });
}
