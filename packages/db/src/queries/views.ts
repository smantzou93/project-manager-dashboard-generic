/**
 * Saved views.
 *
 * How a PM returns to the same consolidated slice before a status meeting
 * without rebuilding the filters each time.
 *
 * Filters are stored as structured JSON, validated on write, rather than as an
 * opaque query string. An agent should be able to read a saved view, see what
 * it selects, and modify it — which it cannot do with `?q=foo&s=1&p=2,3`.
 */

import { sql } from '../client';
import { json } from './scope';
import type { SearchFilters } from './search';

export type SavedViewConfig = {
  filters: Omit<SearchFilters, 'cursor' | 'limit'>;
  /** Chart ids to render. Empty means the view's default set. */
  charts?: string[];
  sort?: 'rank' | 'age' | 'priority';
  description?: string;
};

export type SavedView = {
  id: string;
  name: string;
  kind: string;
  config: SavedViewConfig;
  createdAt: Date;
  updatedAt: Date;
};

export async function listViews(kind?: string): Promise<SavedView[]> {
  return sql<SavedView[]>`
    select id, name, kind, config, created_at as "createdAt", updated_at as "updatedAt"
    from saved_views
    where ${kind ? sql`kind = ${kind}` : sql`true`}
    order by name
  `;
}

export async function getView(id: string): Promise<SavedView | null> {
  const [row] = await sql<SavedView[]>`
    select id, name, kind, config, created_at as "createdAt", updated_at as "updatedAt"
    from saved_views where id = ${id}
  `;
  return row ?? null;
}

export async function createView(input: {
  name: string;
  kind?: string;
  config: SavedViewConfig;
}): Promise<SavedView> {
  const [row] = await sql<[SavedView]>`
    insert into saved_views (name, kind, config)
    values (${input.name}, ${input.kind ?? 'search'}, ${json(input.config)}::jsonb)
    returning id, name, kind, config, created_at as "createdAt", updated_at as "updatedAt"
  `;
  return row;
}

export async function updateView(
  id: string,
  input: { name?: string; config?: SavedViewConfig },
): Promise<SavedView | null> {
  const [row] = await sql<SavedView[]>`
    update saved_views set
      name = coalesce(${input.name ?? null}, name),
      config = ${input.config === undefined ? sql`config` : sql`${json(input.config)}::jsonb`},
      updated_at = now()
    where id = ${id}
    returning id, name, kind, config, created_at as "createdAt", updated_at as "updatedAt"
  `;
  return row ?? null;
}

export async function deleteView(id: string): Promise<boolean> {
  const rows = await sql`delete from saved_views where id = ${id} returning id`;
  return rows.length > 0;
}

/**
 * Views every installation gets, seeded on first run.
 *
 * A fresh clone with no saved views is a blank search box, which is a poor
 * first impression of a tool whose selling point is consolidation. These are
 * the three questions a PM asks most, phrased in categories rather than
 * labels so they work under any preset.
 */
export const BUILTIN_VIEWS: { name: string; config: SavedViewConfig }[] = [
  {
    name: 'Blocked everywhere',
    config: {
      description: 'Everything blocked, across every project.',
      filters: { statusCategory: ['blocked'] },
      sort: 'age',
    },
  },
  {
    name: 'In flight',
    config: {
      description: 'Started and not finished, oldest first.',
      filters: { statusCategory: ['in_progress', 'in_review'] },
      sort: 'age',
    },
  },
  {
    name: 'Waiting to start',
    config: {
      description: 'Nothing has happened to these yet.',
      filters: { statusCategory: ['todo'] },
      sort: 'priority',
    },
  },
];

/** Idempotent: safe on every boot, and never overwrites a user's edit. */
export async function ensureBuiltinViews(): Promise<number> {
  let created = 0;
  for (const view of BUILTIN_VIEWS) {
    const rows = await sql`
      insert into saved_views (name, kind, config)
      values (${view.name}, 'builtin', ${json(view.config)}::jsonb)
      on conflict do nothing
      returning id
    `;
    created += rows.length;
  }
  return created;
}
