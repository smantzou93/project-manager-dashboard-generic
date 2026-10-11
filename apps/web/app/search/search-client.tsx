'use client';

/**
 * Search and saved views.
 *
 * Reads and writes exclusively through the HTTP API, typed from the same
 * schemas the OpenAPI document is generated from — so this component and the
 * published contract cannot disagree.
 *
 * Filter state lives in the URL. That is what makes a result set shareable:
 * paste the address into a meeting invite and the other person sees the same
 * rows, which is most of what a "consolidated view" is for.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import { api, ApiCallError } from '../../lib/client';
import type { SavedView, SearchResponse } from '../../lib/responses';

const CATEGORIES = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'in_review', label: 'In review' },
  { value: 'done', label: 'Done' },
] as const;

type Filters = { q: string; status: string[] };

function filtersToParams(filters: Filters, limit = 50): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.status.length) params.set('status', filters.status.join(','));
  params.set('limit', String(limit));
  params.set('facets', 'true');
  return params;
}

export function SearchClient({
  initial,
  labels,
}: {
  initial: Filters;
  labels: { workItem: string; project: string };
}) {
  const [filters, setFilters] = useState<Filters>(initial);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<ApiCallError | null>(null);
  const [pending, startTransition] = useTransition();

  const params = useMemo(() => filtersToParams(filters), [filters]);

  // Keep the address bar in step, so the current result set is shareable and
  // the back button does what the user expects.
  useEffect(() => {
    const url = `${window.location.pathname}?${params}`;
    window.history.replaceState(null, '', url);
  }, [params]);

  const run = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        setResult(await api.search(params));
      } catch (err) {
        setError(err as ApiCallError);
      }
    });
  }, [params]);

  useEffect(run, [run]);

  useEffect(() => {
    api
      .views()
      .then((r) => setViews(r.views))
      .catch(() => setViews([]));
  }, []);

  const toggleStatus = (value: string) =>
    setFilters((f) => ({
      ...f,
      status: f.status.includes(value) ? f.status.filter((s) => s !== value) : [...f.status, value],
    }));

  const applyView = (view: SavedView) => {
    const vf = view.config.filters as { q?: string; statusCategory?: string[] };
    setFilters({ q: vf.q ?? '', status: vf.statusCategory ?? [] });
  };

  const saveCurrent = async () => {
    const name = window.prompt('Name this view');
    if (!name?.trim()) return;
    try {
      const { view } = await api.createView({
        name: name.trim(),
        config: {
          filters: {
            ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
            ...(filters.status.length ? { statusCategory: filters.status } : {}),
          },
        },
      });
      setViews((v) => [...v, view].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setError(err as ApiCallError);
    }
  };

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="filters">
          <input
            type="search"
            className="field"
            placeholder={`Search ${labels.workItem.toLowerCase()}s across every ${labels.project.toLowerCase()}…`}
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            aria-label="Search text"
          />
          <div className="chips" role="group" aria-label="Filter by status">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`chip ${filters.status.includes(c.value) ? 'chip-on' : ''}`}
                aria-pressed={filters.status.includes(c.value)}
                onClick={() => toggleStatus(c.value)}
              >
                {c.label}
                {result?.facets ?
                  <span className="chip-count">
                    {result.facets.statusCategory.find((f) => f.value === c.value)?.count ?? 0}
                  </span>
                : null}
              </button>
            ))}
          </div>
        </div>

        {views.length > 0 ?
          <div className="views">
            <span className="muted">Saved:</span>
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                className="chip chip-view"
                onClick={() => applyView(v)}
                title={v.config.description}
              >
                {v.name}
              </button>
            ))}
            <button type="button" className="chip chip-add" onClick={() => void saveCurrent()}>
              + save this
            </button>
          </div>
        : null}
      </section>

      {error ?
        <div className="card error-card" role="alert">
          <strong>{error.message}</strong>
          {/* The correlation id is the whole point of showing an error here:
              it is what turns "it broke" into something findable in the logs. */}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Reference <code>{error.correlationId}</code> · code <code>{error.code}</code>
          </div>
        </div>
      : null}

      <section className="card">
        <h2>
          {result ? `${result.total}${result.truncated ? '+' : ''} matching` : 'Searching…'}
          {pending ?
            <span className="muted"> · updating</span>
          : null}
        </h2>
        <p className="defn">
          Across every {labels.project.toLowerCase()}. The address bar holds the current filters, so
          this result set is shareable.
        </p>

        {result && result.hits.length === 0 ?
          <div className="chart-empty">
            <strong>Nothing matches</strong>
            <span>
              {filters.q || filters.status.length ?
                'Try removing a filter.'
              : 'There are no items yet.'}
            </span>
          </div>
        : null}

        {result && result.hits.length > 0 ?
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Title</th>
                  <th scope="col">{labels.project}</th>
                  <th scope="col">Status</th>
                  <th scope="col">Owner</th>
                  <th scope="col" className="num">
                    Age
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.hits.map((hit) => (
                  <tr key={hit.id}>
                    <td className="key-cell">{hit.key}</td>
                    <td>
                      <div className="truncate" title={hit.title}>
                        {hit.title}
                      </div>
                    </td>
                    <td>
                      <a href={`/projects/${hit.projectKey}`}>{hit.projectKey}</a>
                    </td>
                    <td>
                      {/* Display the label, but style by category -- the label
                          is whatever this installation calls it. */}
                      <span className={`badge ${hit.isBlocked ? 'badge-bad' : ''}`}>
                        {hit.status ?? hit.statusCategory}
                      </span>
                    </td>
                    <td className="muted">{hit.assignee ?? '—'}</td>
                    <td className="num">{hit.ageDays === null ? '—' : `${hit.ageDays}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        : null}

        {result?.truncated ?
          <p className="muted" style={{ marginBottom: 0 }}>
            Showing the first {result.hits.length}. Narrow the filters to see fewer.
          </p>
        : null}
      </section>
    </>
  );
}
