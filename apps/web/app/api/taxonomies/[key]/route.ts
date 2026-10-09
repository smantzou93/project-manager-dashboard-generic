import { deleteTaxonomy, getTaxonomy, reorderTerms } from '@pmdash/db/queries';

import { parseBody, route } from '../../../../lib/api';
import { notFound } from '../../../../lib/errors';
import { reorderSchema } from '../../../../lib/schemas';
import { toApiError } from '../../../../lib/taxonomy-errors';

export const GET = route('/api/taxonomies/[key]', async ({ params }) => {
  const taxonomy = await getTaxonomy(params.key!);
  if (!taxonomy) throw notFound(`Taxonomy "${params.key}"`);
  return { taxonomy };
});

/** PATCH — reorder terms. One statement, so a partial reorder cannot happen. */
export const PATCH = route('/api/taxonomies/[key]', async ({ request, params }) => {
  const taxonomy = await getTaxonomy(params.key!);
  if (!taxonomy) throw notFound(`Taxonomy "${params.key}"`);
  const { order } = await parseBody(request, reorderSchema);
  await reorderTerms(taxonomy.id, order);
  return { reordered: order.length };
});

export const DELETE = route('/api/taxonomies/[key]', async ({ params }) => {
  try {
    return await deleteTaxonomy(params.key!);
  } catch (err) {
    throw toApiError(err);
  }
});
