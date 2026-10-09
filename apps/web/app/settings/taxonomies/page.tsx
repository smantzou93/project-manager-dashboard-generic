import { getActivePreset, getLabels } from '@pmdash/db/queries';

import { TaxonomyClient } from './taxonomy-client';

export const dynamic = 'force-dynamic';

/**
 * The shell is server-rendered; the terms are fetched by the client from
 * /api/taxonomies.
 *
 * Deliberately not pre-seeded from the query layer. The two shapes genuinely
 * differ — the query layer returns `Date`, the API contract returns an ISO
 * string, because that is what survives a wire — and TypeScript said so when
 * the server tried to hand one to a component typed from the other.
 *
 * Forcing them together would have meant loosening a type until the error went
 * away, which is how a contract stops meaning anything. This screen is
 * interactive and mutates through the API regardless, so letting it own its
 * own loading is both simpler and more honest.
 */
export default async function TaxonomiesPage() {
  const [preset, labels] = await Promise.all([getActivePreset(), getLabels()]);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Vocabulary</h1>
          <p>
            Every category here is a row you can edit, add to or archive. Nothing is baked into the
            code — which is what lets this app serve a {labels.project.toLowerCase()} in any
            industry.
          </p>
        </div>
        {preset ?
          <span className="asof">preset: {preset}</span>
        : null}
      </div>

      <TaxonomyClient />
    </main>
  );
}
