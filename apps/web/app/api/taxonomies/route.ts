import { createTerm, listTaxonomies } from '@pmdash/db/queries';

import { parseBody, route } from '../../../lib/api';
import { createTermSchema } from '../../../lib/schemas';
import { toApiError } from '../../../lib/taxonomy-errors';
import { z } from 'zod';

/** GET /api/taxonomies?archived=true — every taxonomy with its terms. */
export const GET = route('/api/taxonomies', async ({ request }) => {
  const includeArchived = request.nextUrl.searchParams.get('archived') === 'true';
  return { taxonomies: await listTaxonomies(includeArchived) };
});

const createSchema = createTermSchema.extend({ taxonomyKey: z.string().trim().min(1) });

/** POST /api/taxonomies — add a term. */
export const POST = route('/api/taxonomies', async ({ request }) => {
  const body = await parseBody(request, createSchema);
  try {
    return { term: await createTerm(body) };
  } catch (err) {
    throw toApiError(err);
  }
});
