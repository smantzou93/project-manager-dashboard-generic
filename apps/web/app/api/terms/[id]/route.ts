import { archiveTerm, deleteTerm, restoreTerm, termUsage, updateTerm } from '@pmdash/db/queries';

import { parseBody, route } from '../../../../lib/api';
import { updateTermSchema } from '../../../../lib/schemas';
import { toApiError } from '../../../../lib/taxonomy-errors';

/** GET — what references this term, so the UI knows whether to offer delete. */
export const GET = route('/api/terms/[id]', async ({ params }) => ({
  usage: await termUsage(params.id!),
}));

export const PATCH = route('/api/terms/[id]', async ({ request, params }) => {
  const body = await parseBody(request, updateTermSchema);
  try {
    return { term: await updateTerm(params.id!, body) };
  } catch (err) {
    throw toApiError(err);
  }
});

/**
 * DELETE — archives by default; `?hard=true` deletes outright.
 *
 * Archiving is the default because it is almost always what "remove this
 * category" means: the term leaves the pickers while history keeps rendering.
 * A hard delete is refused when anything references the term, and the refusal
 * names the blocking rows.
 */
export const DELETE = route('/api/terms/[id]', async ({ request, params }) => {
  const hard = request.nextUrl.searchParams.get('hard') === 'true';
  try {
    return hard ? await deleteTerm(params.id!) : await archiveTerm(params.id!);
  } catch (err) {
    throw toApiError(err);
  }
});

/** POST — restore an archived term. */
export const POST = route('/api/terms/[id]', async ({ params }) => restoreTerm(params.id!));
