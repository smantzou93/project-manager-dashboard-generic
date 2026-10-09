import { searchFacets, searchWorkItems } from '@pmdash/db/queries';

import { parseQuery, route } from '../../../lib/api';
import { searchQuerySchema } from '../../../lib/schemas';
import { resolveAsOf } from '../../../lib/view-context';

/**
 * GET /api/search
 *
 * Cross-project by default. Keyset pagination, so a long result set does not
 * shift under the reader while they page through it.
 */
export const GET = route('/api/search', async ({ request }) => {
  const q = parseQuery(request, searchQuerySchema);
  const asOf = resolveAsOf();

  const filters = {
    q: q.q,
    projectId: q.project,
    portfolioId: q.portfolio,
    statusCategory: q.status,
    typeTermId: q.type,
    priorityTermId: q.priority,
    assigneeId: q.assignee,
    isBlocked: q.blocked,
    from: q.from,
    to: q.to,
    limit: q.limit,
    cursor:
      q.cursorRank !== undefined && q.cursorId ? { rank: q.cursorRank, id: q.cursorId } : undefined,
  };

  const [result, facets] = await Promise.all([
    searchWorkItems(asOf, filters),
    q.facets ? searchFacets(filters) : Promise.resolve(undefined),
  ]);

  return { ...result, ...(facets ? { facets } : {}) };
});
