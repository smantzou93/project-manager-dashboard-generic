'use client';

/**
 * Taxonomy admin.
 *
 * The screen where the project's central promise becomes something a user can
 * act on: delete the categories you do not want, add your own, and have every
 * chart keep working.
 *
 * Which means the guards matter more than the form. The API refuses changes
 * that would break the metrics; this surfaces *why* rather than showing a red
 * box, because "A workflow needs at least one done status" is actionable and
 * "409" is not.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, ApiCallError } from '../../../lib/client';
import type { Taxonomy, Term } from '../../../lib/responses';

const CATEGORIES = [
  { value: 'todo', label: 'To do', hint: 'Not started yet' },
  { value: 'in_progress', label: 'In progress', hint: 'Someone is working on it' },
  { value: 'blocked', label: 'Blocked', hint: 'Stopped by something external' },
  { value: 'in_review', label: 'In review', hint: 'Done, awaiting a check' },
  { value: 'done', label: 'Done', hint: 'Finished' },
  { value: 'cancelled', label: 'Cancelled', hint: 'Will not be done' },
] as const;

export function TaxonomyClient() {
  const [taxonomies, setTaxonomies] = useState<Taxonomy[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<ApiCallError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Memoised so the effect below can depend on it honestly rather than
  // suppressing the dependency warning.
  const refresh = useCallback(async () => {
    try {
      setTaxonomies((await api.taxonomies(showArchived)).taxonomies);
    } catch (err) {
      setError(err as ApiCallError);
    }
  }, [showArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Every mutation goes through this, so no path forgets to surface a refusal. */
  const act = async (id: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await refresh();
    } catch (err) {
      setError(err as ApiCallError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error ?
        <div className="card error-card" role="alert">
          <strong>{error.message}</strong>
          {/* The guards are the interesting part of this screen, so the
              refusal is explained rather than reduced to a status code. */}
          {error.code === 'TERM_IN_USE' ?
            <p className="muted">
              Archiving keeps history intact and removes it from the pickers, which is almost always
              what is wanted.
            </p>
          : null}
          <div className="muted" style={{ fontSize: 12 }}>
            <code>{error.code}</code> · reference <code>{error.correlationId}</code>
          </div>
        </div>
      : null}

      {notice ?
        <div className="all-clear" style={{ marginBottom: 16 }} role="status">
          <span aria-hidden>✓</span> {notice}
        </div>
      : null}

      {taxonomies === null ?
        <div className="chart-empty">
          <strong>Loading the vocabulary…</strong>
        </div>
      : null}

      <label className="toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived terms
      </label>

      {(taxonomies ?? []).map((taxonomy) => (
        <section className="card" key={taxonomy.id} style={{ marginBottom: 16 }}>
          <h2>
            {taxonomy.label}
            {taxonomy.isSystem ?
              <span className="badge">system</span>
            : null}
            {taxonomy.drivesStatusCategory ?
              <span className="badge badge-ok">drives the metrics</span>
            : null}
          </h2>
          <p className="defn">
            {taxonomy.drivesStatusCategory ?
              'Each status maps onto a category. That mapping is what lets your own words work with every chart — name a status whatever you like, and point it at the category it behaves like.'
            : (taxonomy.description ?? `The ${taxonomy.label.toLowerCase()} you can choose from.`)}
          </p>

          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Key</th>
                  {taxonomy.drivesStatusCategory ?
                    <th scope="col">Behaves like</th>
                  : null}
                  <th scope="col" className="num">
                    In use
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {taxonomy.terms.map((term) => (
                  <TermRow
                    key={term.id}
                    term={term}
                    taxonomy={taxonomy}
                    busy={busy === term.id}
                    onAct={act}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <AddTerm taxonomy={taxonomy} onAct={act} />
        </section>
      ))}
    </>
  );
}

function TermRow({
  term,
  taxonomy,
  busy,
  onAct,
}: {
  term: Term;
  taxonomy: Taxonomy;
  busy: boolean;
  onAct: (id: string, fn: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const archived = term.archivedAt !== null;

  return (
    <tr style={archived ? { opacity: 0.55 } : undefined}>
      <td>
        <input
          className="field field-inline"
          defaultValue={term.label}
          aria-label={`Label for ${term.slug}`}
          onBlur={(e) => {
            const label = e.target.value.trim();
            if (label && label !== term.label) {
              void onAct(
                term.id,
                () => api.updateTerm(term.id, { label }),
                `Renamed to "${label}".`,
              );
            }
          }}
        />
      </td>
      <td className="key-cell">{term.slug}</td>

      {taxonomy.drivesStatusCategory ?
        <td>
          <select
            className="field field-inline"
            defaultValue={term.statusCategory ?? ''}
            aria-label={`Category for ${term.label}`}
            onChange={(e) => {
              // `void` on the expression is not enough here: the handler must
              // return void, not a discarded promise.
              const next = e.target.value;
              void onAct(
                term.id,
                () => api.updateTerm(term.id, { statusCategory: next }),
                `"${term.label}" now behaves like ${next}.`,
              );
            }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value} title={c.hint}>
                {c.label}
              </option>
            ))}
          </select>
        </td>
      : null}

      <td className="num">{term.usageCount}</td>

      <td>
        {archived ?
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() =>
              void onAct(term.id, () => api.restoreTerm(term.id), `Restored "${term.label}".`)
            }
          >
            Restore
          </button>
        : <>
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() =>
                void onAct(
                  term.id,
                  () => api.archiveTerm(term.id),
                  `Archived "${term.label}". Existing records keep it.`,
                )
              }
            >
              Archive
            </button>
            {/* Delete is only offered when nothing references the term. The
                API refuses otherwise, but offering a button that always fails
                is its own kind of rude. */}
            {term.usageCount === 0 ?
              <button
                type="button"
                className="chip chip-danger"
                disabled={busy}
                onClick={() =>
                  void onAct(term.id, () => api.deleteTerm(term.id), `Deleted "${term.label}".`)
                }
              >
                Delete
              </button>
            : null}
          </>
        }
      </td>
    </tr>
  );
}

function AddTerm({
  taxonomy,
  onAct,
}: {
  taxonomy: Taxonomy;
  onAct: (id: string, fn: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('todo');

  /** Derived, not asked for. A slug is machine detail the user should not have to invent. */
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const submit = () => {
    if (!slug) return;
    void onAct(
      `add-${taxonomy.id}`,
      () =>
        api.createTerm({
          taxonomyKey: taxonomy.key,
          slug,
          label: label.trim(),
          ...(taxonomy.drivesStatusCategory ? { statusCategory: category } : {}),
        }),
      `Added "${label.trim()}".`,
    );
    setLabel('');
  };

  return (
    <div className="add-row">
      <input
        className="field"
        placeholder={`Add a ${taxonomy.label.toLowerCase().replace(/s$/, '')}…`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        aria-label={`New ${taxonomy.label}`}
      />
      {taxonomy.drivesStatusCategory ?
        <select
          className="field"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Behaves like"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              behaves like {c.label}
            </option>
          ))}
        </select>
      : null}
      <button type="button" className="chip chip-add" onClick={submit} disabled={!slug}>
        Add
      </button>
      {slug ?
        <span className="muted">key: {slug}</span>
      : null}
    </div>
  );
}
