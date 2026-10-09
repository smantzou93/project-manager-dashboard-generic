import { getLabels } from '@pmdash/db/queries';

import { SearchClient } from './search-client';

export const dynamic = 'force-dynamic';

/**
 * The search page.
 *
 * The shell is server-rendered for the preset vocabulary; the interactive part
 * is a client component talking to /api/search. This is the case where the UI
 * genuinely is driven by the API — filters change on every keystroke, so there
 * is no server render to piggyback on.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const labels = await getLabels();

  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <p>
            Everything, across every {labels.project.toLowerCase()} — filters live in the URL so a
            view can be shared.
          </p>
        </div>
      </div>

      <SearchClient
        initial={{
          q: first(params.q),
          status: first(params.status) ? first(params.status).split(',') : [],
        }}
        labels={{ workItem: labels.workItem, project: labels.project }}
      />
    </main>
  );
}
