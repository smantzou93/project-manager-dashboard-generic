/**
 * Shared scoping for every metric query.
 *
 * Two rules hold across this whole directory, and both exist because getting
 * them wrong produces a chart that is subtly, confidently wrong rather than
 * visibly broken:
 *
 *  1. `asOf` is always passed in, never read from the clock inside a query.
 *     Metrics are time-relative ("aging 12 days", "last 6 weeks"), so a query
 *     that calls now() internally cannot be tested -- its answer changes every
 *     day -- and cannot answer "what did this look like at the end of Q2".
 *
 *  2. Group items are excluded from every aggregate. Parent containers (epic /
 *     work package / phase, depending on preset) carry startedAt = projectStart
 *     and no completedAt, because a container genuinely is in flight for the
 *     project's duration. Counted alongside leaf items they inflate WIP and
 *     dominate aging. They are identified by the 'group' label rather than by
 *     type, because the type term's slug differs per preset.
 */

import { sql } from '../client';

/** The slice a metric is computed over. All fields optional; omitted = all. */
export type Scope = {
  projectId?: string;
  portfolioId?: string;
  iterationId?: string;
  /** Inclusive lower bound on the metric's own date dimension. */
  from?: Date;
  /** Inclusive upper bound. Defaults to `asOf`. */
  to?: Date;
};

/**
 * The label that marks a parent container. Set by the seed and by any importer
 * that creates grouping rows; see the file header for why it is a label.
 */
export const GROUP_LABEL = 'group';

/**
 * `true` when the row is a leaf item that belongs in aggregates.
 *
 * A function rather than a const: building the fragment at module scope would
 * open a database connection the moment anything in this package is imported,
 * including the pure helpers that never touch Postgres.
 */
export const isLeaf = () => sql`not (${GROUP_LABEL} = any(wi.labels))`;

/**
 * Project / portfolio / iteration filter, as a composable fragment.
 *
 * Built from a list so an empty scope yields `true` rather than a dangling
 * `and`, and so adding a dimension does not mean touching every call site.
 */
export function scopeFilter(scope: Scope) {
  const clauses = [];
  if (scope.projectId) clauses.push(sql`wi.project_id = ${scope.projectId}`);
  if (scope.iterationId) clauses.push(sql`wi.iteration_id = ${scope.iterationId}`);
  if (scope.portfolioId) {
    clauses.push(
      sql`wi.project_id in (select id from projects where portfolio_id = ${scope.portfolioId})`,
    );
  }
  if (clauses.length === 0) return sql`true`;
  return clauses.reduce((acc, c) => sql`${acc} and ${c}`);
}

/** Leaf-only, in-scope. The predicate nearly every metric starts from. */
export function baseFilter(scope: Scope) {
  return sql`${isLeaf()} and ${scopeFilter(scope)}`;
}

/** Whole days between two instants, truncated. */
export const daysBetween = (a: Date, b: Date) =>
  Math.floor((b.getTime() - a.getTime()) / 86_400_000);

/** `n` days before `d`. */
export const subDays = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);

/**
 * Renders a Date for interpolation into a query. Always pair it with an
 * explicit `::timestamptz` cast.
 *
 * Passing a bare `Date` would be the obvious thing to write, and it works on a
 * plain postgres.js connection -- but not on this one. `drizzle()` mutates the
 * instance it is handed, replacing the type serializers so that timestamps
 * round-trip as strings for Drizzle's own mapping layer. After that, raw
 * postgres.js binds a Date through the text serializer and throws
 * "The string argument must be of type string ... Received an instance of Date".
 *
 * The connection is shared between Drizzle and raw SQL on purpose (one pool,
 * one place to configure), so the fix belongs here: send an unambiguous ISO-8601
 * string and let Postgres do the conversion. Explicit beats implicit anyway --
 * it also removes any dependence on the driver's timezone handling.
 */
export const ts = (d: Date) => d.toISOString();
