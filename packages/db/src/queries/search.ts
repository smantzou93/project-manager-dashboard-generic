/**
 * Cross-project search.
 *
 * Cross-project by default, because consolidation is the point. A PM asking
 * "what is blocked" wants the answer across everything they own, not one
 * project at a time.
 */

import { sql } from '../client';
import { ts } from './scope';

export type SearchFilters = {
  /** Free text. Matched against title and description. */
  q?: string;
  projectId?: string;
  portfolioId?: string;
  statusCategory?: string[];
  typeTermId?: string[];
  priorityTermId?: string[];
  assigneeId?: string;
  isBlocked?: boolean;
  /** Completed on or after. */
  from?: Date;
  /** Completed on or before. */
  to?: Date;
  limit?: number;
  /**
   * Keyset cursor from a previous page, not an offset.
   *
   * Offset pagination shifts under the reader: anything inserted or completed
   * while they are reading moves every later row, so page 2 silently skips
   * or repeats. A keyset is stable.
   */
  cursor?: { rank: number; id: string };
};

export type SearchHit = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  projectKey: string;
  projectName: string;
  status: string | null;
  statusCategory: string;
  type: string | null;
  priority: string | null;
  assignee: string | null;
  isBlocked: boolean;
  ageDays: number | null;
  completedAt: Date | null;
  rank: number;
};

export type SearchResult = {
  hits: SearchHit[];
  /** Pass back as `cursor` for the next page. Null when this is the last. */
  nextCursor: { rank: number; id: string } | null;
  /** Total matches, capped — an exact count on a large table is its own query. */
  total: number;
  truncated: boolean;
};

const MAX_LIMIT = 100;
const COUNT_CAP = 1000;

/**
 * Searches work items.
 *
 * Text matching uses `plainto_tsquery`, which treats input as words rather
 * than tsquery syntax. A user typing `blocked & !done` should get results for
 * those words, not a syntax error — and an unescaped tsquery is a denial of
 * service waiting to happen.
 *
 * The `to_tsvector` expression here must stay identical to the one in
 * `work_items_search_idx`, or Postgres will not use the index.
 */
export async function searchWorkItems(
  asOf: Date,
  filters: SearchFilters = {},
): Promise<SearchResult> {
  const limit = Math.min(filters.limit ?? 25, MAX_LIMIT);
  const text = filters.q?.trim();

  const clauses = [sql`not ('group' = any(wi.labels))`];

  if (text) {
    clauses.push(
      sql`to_tsvector('english', coalesce(wi.title, '') || ' ' || coalesce(wi.description, ''))
          @@ plainto_tsquery('english', ${text})`,
    );
  }
  if (filters.projectId) clauses.push(sql`wi.project_id = ${filters.projectId}`);
  if (filters.portfolioId) {
    clauses.push(
      sql`wi.project_id in (select id from projects where portfolio_id = ${filters.portfolioId})`,
    );
  }
  if (filters.statusCategory?.length) {
    clauses.push(sql`wi.status_category::text = any(${filters.statusCategory})`);
  }
  if (filters.typeTermId?.length) clauses.push(sql`wi.type_term_id = any(${filters.typeTermId})`);
  if (filters.priorityTermId?.length) {
    clauses.push(sql`wi.priority_term_id = any(${filters.priorityTermId})`);
  }
  if (filters.assigneeId) clauses.push(sql`wi.assignee_id = ${filters.assigneeId}`);
  if (filters.isBlocked !== undefined) clauses.push(sql`wi.is_blocked = ${filters.isBlocked}`);
  if (filters.from) clauses.push(sql`wi.completed_at >= ${ts(filters.from)}::timestamptz`);
  if (filters.to) clauses.push(sql`wi.completed_at <= ${ts(filters.to)}::timestamptz`);

  const where = clauses.reduce((acc, c) => sql`${acc} and ${c}`);

  // Relevance when there is a query, recency otherwise. Ranking every row 0
  // and sorting by id would be stable but useless.
  const rank =
    text ?
      sql`ts_rank(
        to_tsvector('english', coalesce(wi.title, '') || ' ' || coalesce(wi.description, '')),
        plainto_tsquery('english', ${text})
      )::float8`
    : sql`extract(epoch from coalesce(wi.completed_at, wi.started_at, wi.source_created_at))::float8 / 1e9`;

  const cursor =
    filters.cursor ?
      sql`and (${rank}, wi.id) < (${filters.cursor.rank}, ${filters.cursor.id})`
    : sql``;

  const rows = await sql<SearchHit[]>`
    select wi.id, wi.key, wi.title, wi.description,
           p.key as "projectKey", p.name as "projectName",
           st.label as "status", wi.status_category::text as "statusCategory",
           tt.label as "type", pt.label as "priority",
           pe.display_name as "assignee",
           wi.is_blocked as "isBlocked",
           case when wi.started_at is not null and wi.completed_at is null
                then round((extract(epoch from (${ts(asOf)}::timestamptz - wi.started_at)) / 86400)::numeric, 1)::float8
           end as "ageDays",
           wi.completed_at as "completedAt",
           ${rank} as "rank"
    from work_items wi
      join projects p on p.id = wi.project_id
      left join taxonomy_terms st on st.id = wi.status_term_id
      left join taxonomy_terms tt on tt.id = wi.type_term_id
      left join taxonomy_terms pt on pt.id = wi.priority_term_id
      left join people pe on pe.id = wi.assignee_id
    where ${where} ${cursor}
    order by "rank" desc, wi.id desc
    limit ${limit + 1}
  `;

  // One extra row tells us whether another page exists without a second query.
  const hasMore = rows.length > limit;
  const hits = hasMore ? rows.slice(0, limit) : rows;

  const [counted] = await sql<[{ total: number }]>`
    select count(*)::int as "total" from (
      select 1 from work_items wi where ${where} limit ${COUNT_CAP}
    ) capped
  `;

  const last = hits.at(-1);
  return {
    hits,
    nextCursor: hasMore && last ? { rank: last.rank, id: last.id } : null,
    total: counted.total,
    truncated: counted.total >= COUNT_CAP,
  };
}

/** Facet counts for the current filter set, so the UI can show what narrowing does. */
export async function searchFacets(filters: SearchFilters = {}): Promise<{
  statusCategory: { value: string; count: number }[];
  project: { value: string; label: string; count: number }[];
}> {
  const text = filters.q?.trim();
  const base =
    text ?
      sql`to_tsvector('english', coalesce(wi.title, '') || ' ' || coalesce(wi.description, ''))
          @@ plainto_tsquery('english', ${text})`
    : sql`true`;

  const [byStatus, byProject] = await Promise.all([
    sql<{ value: string; count: number }[]>`
      select wi.status_category::text as "value", count(*)::int as "count"
      from work_items wi
      where not ('group' = any(wi.labels)) and ${base}
      group by 1 order by 2 desc
    `,
    sql<{ value: string; label: string; count: number }[]>`
      select p.key as "value", p.name as "label", count(*)::int as "count"
      from work_items wi join projects p on p.id = wi.project_id
      where not ('group' = any(wi.labels)) and ${base}
      group by 1, 2 order by 3 desc
    `,
  ]);

  return { statusCategory: byStatus, project: byProject };
}
