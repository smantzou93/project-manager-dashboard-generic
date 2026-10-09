import { deleteView, getView, updateView } from '@pmdash/db/queries';

import { parseBody, route } from '../../../../lib/api';
import { notFound } from '../../../../lib/errors';
import { updateViewSchema } from '../../../../lib/schemas';

export const GET = route('/api/views/[id]', async ({ params }) => {
  const view = await getView(params.id!);
  if (!view) throw notFound('View');
  return { view };
});

export const PATCH = route('/api/views/[id]', async ({ request, params }) => {
  const body = await parseBody(request, updateViewSchema);
  const view = await updateView(params.id!, body);
  if (!view) throw notFound('View');
  return { view };
});

export const DELETE = route('/api/views/[id]', async ({ params }) => {
  if (!(await deleteView(params.id!))) throw notFound('View');
  return { deleted: true };
});
