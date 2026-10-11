import { dashboardSnapshot } from '@pmdash/db/queries';

import { parseQuery, route } from '../../../lib/api';
import { metricsQuerySchema } from '../../../lib/schemas';
import { resolveAsOf } from '../../../lib/view-context';

/**
 * GET /api/metrics
 *
 * The same snapshot the dashboard renders, as JSON. Exists so an agent, a
 * script or a status-report generator can read the numbers without scraping
 * the page — and so it is the *same* numbers, not a second implementation.
 *
 * `asOf` is a query parameter, so "what did this look like at the end of Q2"
 * costs nothing extra.
 */
export const GET = route('/api/metrics', async ({ request }) => {
  const q = parseQuery(request, metricsQuerySchema);
  return dashboardSnapshot(q.asOf ?? resolveAsOf(), {
    projectId: q.project,
    portfolioId: q.portfolio,
  });
});
