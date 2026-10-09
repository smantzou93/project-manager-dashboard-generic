import { createView, listViews } from '@pmdash/db/queries';

import { parseBody, route } from '../../../lib/api';
import { createViewSchema } from '../../../lib/schemas';

export const GET = route('/api/views', async ({ request }) => ({
  views: await listViews(request.nextUrl.searchParams.get('kind') ?? undefined),
}));

export const POST = route('/api/views', async ({ request }) => ({
  view: await createView(await parseBody(request, createViewSchema)),
}));
