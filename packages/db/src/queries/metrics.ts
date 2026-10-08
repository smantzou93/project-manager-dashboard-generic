/**
 * Flow metrics.
 *
 * Every definition here is stated in its docstring and mirrored in
 * docs/METRICS.md, because a dashboard number whose definition is unclear gets
 * argued about instead of acted on. The unit tests assert these against a
 * pinned-clock seed, so changing a definition breaks a test rather than quietly
 * changing a chart.
 *
 * See ./scope.ts for the two invariants that hold throughout: `asOf` is always
 * injected, and group items never enter an aggregate.
 */

import { sql } from '../client.js';
import { baseFilter, subDays, ts, type Scope } from './scope.js';

// ---------------------------------------------------------------------------
// Cycle and lead time
// ---------------------------------------------------------------------------

export type DurationStats = {
  /** Items the statistic is computed from. Below ~8 the percentiles are noise. */
  n: number;
  medianDays: number | null;
  p85Days: number | null;
};

/**
 * Cycle time: `completedAt - startedAt`. Team working time.
 *
 * Reported as median and 85th percentile, never a mean. Cycle-time
 * distributions have a long right tail -- a handful of items that dragged for
 * weeks -- and the mean sits above most of the data, so it systematically
 * overstates the typical case while understating the tail. The median says what
 * usually happens; the p85 is what you quote when committing to a date.
 */
export async function cycleTime(asOf: Date, scope: Scope = {}): Promise<DurationStats> {
  const [row] = await sql<[DurationStats]>`
    select
      count(*)::int as "n",
      round(percentile_cont(0.5)  within group (
        order by extract(epoch from (wi.completed_at - wi.started_at)) / 86400
      )::numeric, 2)::float8 as "medianDays",
      round(percentile_cont(0.85) within group (
        order by extract(epoch from (wi.completed_at - wi.started_at)) / 86400
      )::numeric, 2)::float8 as "p85Days"
    from work_items wi
    where ${baseFilter(scope)}
      and wi.completed_at is not null
      and wi.started_at is not null
      and wi.completed_at <= ${ts(asOf)}::timestamptz
  `;
  return row;
}

/**
 * Lead time: `completedAt - sourceCreatedAt`. The wait as the requester
 * experienced it, including time queued before anyone picked the work up.
 *
 * Measured from `source_created_at`, never `created_at`. `created_at` is row
 * bookkeeping -- the moment this database first saw the row -- so for imported
 * data the two differ by months and lead time from `created_at` would report
 * the import lag instead of the real wait.
 */
export async function leadTime(asOf: Date, scope: Scope = {}): Promise<DurationStats> {
  const [row] = await sql<[DurationStats]>`
    select
      count(*)::int as "n",
      round(percentile_cont(0.5)  within group (
        order by extract(epoch from (wi.completed_at - wi.source_created_at)) / 86400
      )::numeric, 2)::float8 as "medianDays",
      round(percentile_cont(0.85) within group (
        order by extract(epoch from (wi.completed_at - wi.source_created_at)) / 86400
      )::numeric, 2)::float8 as "p85Days"
    from work_items wi
    where ${baseFilter(scope)}
      and wi.completed_at is not null
      and wi.source_created_at is not null
      and wi.completed_at <= ${ts(asOf)}::timestamptz
  `;
  return row;
}

/** One completed item, for the cycle-time scatter. */
export type CycleScatterPoint = {
  id: string;
  key: string;
  title: string;
  completedAt: Date;
  cycleDays: number;
};

export async function cycleTimeScatter(
  asOf: Date,
  scope: Scope = {},
  days = 90,
): Promise<CycleScatterPoint[]> {
  return sql<CycleScatterPoint[]>`
    select wi.id, wi.key, wi.title,
           wi.completed_at as "completedAt",
           round((extract(epoch from (wi.completed_at - wi.started_at)) / 86400)::numeric, 2)::float8
             as "cycleDays"
    from work_items wi
    where ${baseFilter(scope)}
      and wi.completed_at is not null
      and wi.started_at is not null
      and wi.completed_at <= ${ts(asOf)}::timestamptz
      and wi.completed_at >= ${ts(subDays(asOf, days))}::timestamptz
    order by wi.completed_at
  `;
}

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

export type ThroughputBucket = { weekStart: string; completed: number };

/**
 * Throughput: items completed per calendar week.
 *
 * Deliberately estimate-free. Velocity needs story points, which plenty of
 * teams -- and most non-software PMs -- never record. Throughput works
 * everywhere and answers the same planning question.
 *
 * Weeks are ISO weeks (Monday start) via date_trunc, and the series is
 * gap-filled so a zero week renders as zero rather than vanishing and making
 * the line misleadingly smooth.
 */
export async function throughput(
  asOf: Date,
  scope: Scope = {},
  weeks = 12,
): Promise<ThroughputBucket[]> {
  const from = subDays(asOf, weeks * 7);
  return sql<ThroughputBucket[]>`
    with weeks as (
      select generate_series(
        date_trunc('week', ${ts(from)}::timestamptz),
        date_trunc('week', ${ts(asOf)}::timestamptz),
        interval '1 week'
      ) as week_start
    ),
    done as (
      select date_trunc('week', wi.completed_at) as week_start, count(*)::int as completed
      from work_items wi
      where ${baseFilter(scope)}
        and wi.completed_at is not null
        and wi.completed_at <= ${ts(asOf)}::timestamptz
        and wi.completed_at >= ${ts(from)}::timestamptz
      group by 1
    )
    select to_char(w.week_start, 'YYYY-MM-DD') as "weekStart",
           coalesce(d.completed, 0) as "completed"
    from weeks w left join done d on d.week_start = w.week_start
    order by w.week_start
  `;
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

export type VelocityBucket = {
  iterationId: string;
  name: string;
  startDate: string;
  endDate: string;
  state: string;
  committedPoints: number | null;
  completedPoints: number;
  completedCount: number;
};

/**
 * Velocity: estimate units completed per closed iteration.
 *
 * Only closed iterations count. An in-flight iteration always looks like a
 * velocity collapse, and including it drags every trend line down for reasons
 * that have nothing to do with the team.
 *
 * Returns `completedPoints: 0` for teams that do not estimate; read
 * `completedCount` (or `throughput`) instead in that case.
 */
export async function velocity(
  asOf: Date,
  scope: Scope = {},
  limit = 10,
): Promise<VelocityBucket[]> {
  const rows = await sql<VelocityBucket[]>`
    select it.id as "iterationId", it.name, it.start_date as "startDate",
           it.end_date as "endDate", it.state::text as "state",
           it.committed_points::float8 as "committedPoints",
           coalesce(sum(wi.estimate) filter (where wi.completed_at is not null), 0)::float8
             as "completedPoints",
           count(wi.id) filter (where wi.completed_at is not null)::int as "completedCount"
    from iterations it
      left join work_items wi
        on wi.iteration_id = it.id
       and not ('group' = any(wi.labels))
       and wi.completed_at <= ${ts(asOf)}::timestamptz
    -- Strictly before today: an iteration ending *today* has not finished yet,
    -- and counting it reports a partial result as if it were final.
    where it.end_date < ${ts(asOf)}::timestamptz::date
      and (${scope.projectId ? sql`it.project_id = ${scope.projectId}` : sql`true`})
      and (${
        scope.portfolioId ?
          sql`it.project_id in (select id from projects where portfolio_id = ${scope.portfolioId})`
        : sql`true`
      })
    group by it.id, it.name, it.start_date, it.end_date, it.state, it.committed_points
    order by it.end_date desc
    limit ${limit}
  `;
  // Oldest first, so a chart reads left to right in time.
  return rows.reverse();
}

// ---------------------------------------------------------------------------
// Cumulative flow
// ---------------------------------------------------------------------------

export type FlowDay = { day: string; category: string; count: number };

/**
 * Cumulative flow: how many items sat in each status category on each day.
 *
 * Reconstructed from `status_transitions`, which is the only way to answer it.
 * A table holding just the current status cannot say how many items were in
 * review three weeks ago.
 *
 * Each transition opens an interval that the next one closes, so an item's
 * state on a given day is the interval covering it. The interval before the
 * first transition uses that transition's `from_category`; an item that never
 * moved uses its current category for its whole life.
 */
export async function cumulativeFlow(asOf: Date, scope: Scope = {}, days = 60): Promise<FlowDay[]> {
  const from = subDays(asOf, days);
  return sql<FlowDay[]>`
    with scoped as (
      select wi.id, wi.source_created_at, wi.status_category, wi.labels, wi.project_id
      from work_items wi
      where ${baseFilter(scope)}
    ),
    intervals as (
      -- State after each transition, until the following one.
      select st.work_item_id, st.to_category as category, st.occurred_at as from_t,
             lead(st.occurred_at) over (partition by st.work_item_id order by st.id) as to_t
      from status_transitions st
      join scoped s on s.id = st.work_item_id
      union all
      -- State before the first transition (or the whole life, if none).
      select s.id,
             coalesce(
               (select st.from_category from status_transitions st
                 where st.work_item_id = s.id order by st.id limit 1),
               s.status_category
             ),
             s.source_created_at,
             (select min(st.occurred_at) from status_transitions st where st.work_item_id = s.id)
      from scoped s
    ),
    days as (
      select generate_series(
        date_trunc('day', ${ts(from)}::timestamptz),
        date_trunc('day', ${ts(asOf)}::timestamptz),
        interval '1 day'
      ) as day
    )
    -- An item's state for a day is sampled at one instant: the last microsecond
    -- of that day. Both bounds must use that same instant.
    --
    -- Comparing from_t against end-of-day but to_t against start-of-day looks
    -- equivalent and is not: it counts an item twice on any day it moved, once
    -- for the interval it left (which ended after midnight) and once for the
    -- interval it entered (which began before the day was out). That inflates
    -- the stacked total above the number of items that exist, which is exactly
    -- how the bug was caught.
    select to_char(d.day, 'YYYY-MM-DD') as "day",
           i.category::text as "category",
           count(*)::int as "count"
    from days d
    cross join lateral (select d.day + interval '1 day' - interval '1 microsecond' as eod) e
    join intervals i
      on i.category is not null
     and i.from_t <= e.eod
     and (i.to_t is null or i.to_t > e.eod)
    group by 1, 2
    order by 1, 2
  `;
}

// ---------------------------------------------------------------------------
// Work in progress
// ---------------------------------------------------------------------------

export type AgingItem = {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  status: string;
  statusCategory: string;
  assignee: string | null;
  isBlocked: boolean;
  ageDays: number;
};

/**
 * Aging WIP: everything in flight, oldest first, with how long it has been in
 * flight.
 *
 * This is the most actionable table on the dashboard. A burndown tells you that
 * you are behind; aging WIP tells you which item to go ask about, and it does
 * so earlier than any trend line, because an item stops moving long before the
 * chart bends.
 *
 * In flight = started, not completed, not cancelled. Age is measured from
 * `startedAt`, so it is time spent working, comparable against cycle time.
 */
export async function agingWip(asOf: Date, scope: Scope = {}): Promise<AgingItem[]> {
  return sql<AgingItem[]>`
    select wi.id, wi.key, wi.title,
           p.key as "projectKey",
           tt.label as "status",
           wi.status_category::text as "statusCategory",
           pe.display_name as "assignee",
           wi.is_blocked as "isBlocked",
           round((extract(epoch from (${ts(asOf)}::timestamptz - wi.started_at)) / 86400)::numeric, 1)::float8
             as "ageDays"
    from work_items wi
      join projects p on p.id = wi.project_id
      left join taxonomy_terms tt on tt.id = wi.status_term_id
      left join people pe on pe.id = wi.assignee_id
    where ${baseFilter(scope)}
      and wi.started_at is not null
      and wi.started_at <= ${ts(asOf)}::timestamptz
      and wi.completed_at is null
      and wi.status_category <> 'cancelled'
    order by wi.started_at
  `;
}

export type WipSummary = { inFlight: number; blocked: number; todo: number; done: number };

/** Current counts by broad state, for the KPI tiles. */
export async function wipSummary(asOf: Date, scope: Scope = {}): Promise<WipSummary> {
  const [row] = await sql<[WipSummary]>`
    select
      count(*) filter (
        where wi.started_at is not null and wi.started_at <= ${ts(asOf)}::timestamptz
          and wi.completed_at is null and wi.status_category <> 'cancelled'
      )::int as "inFlight",
      count(*) filter (where wi.status_category = 'blocked')::int as "blocked",
      count(*) filter (where wi.status_category = 'todo')::int as "todo",
      count(*) filter (where wi.completed_at is not null and wi.completed_at <= ${ts(asOf)}::timestamptz)::int as "done"
    from work_items wi
    where ${baseFilter(scope)}
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Burnup and forecast
// ---------------------------------------------------------------------------

export type BurnupPoint = { day: string; completed: number; scope: number };

/**
 * Burnup: cumulative completed against cumulative total scope, per day.
 *
 * Preferred over a burndown because the two lines separate scope change from
 * progress. A burndown that flattens looks identical whether the team stopped
 * delivering or the work grew underneath them; a burnup shows which happened.
 */
export async function burnup(asOf: Date, scope: Scope = {}, days = 90): Promise<BurnupPoint[]> {
  const from = subDays(asOf, days);
  return sql<BurnupPoint[]>`
    with days as (
      select generate_series(
        date_trunc('day', ${ts(from)}::timestamptz),
        date_trunc('day', ${ts(asOf)}::timestamptz),
        interval '1 day'
      ) as day
    ),
    scoped as (
      select wi.source_created_at, wi.completed_at
      from work_items wi
      where ${baseFilter(scope)}
    )
    select to_char(d.day, 'YYYY-MM-DD') as "day",
           count(*) filter (where s.completed_at is not null and s.completed_at <= d.day
                              + interval '1 day' - interval '1 microsecond')::int as "completed",
           count(*) filter (where s.source_created_at <= d.day
                              + interval '1 day' - interval '1 microsecond')::int as "scope"
    from days d cross join scoped s
    group by 1
    order by 1
  `;
}

export type Forecast =
  | { ok: true; completionDate: string; daysRemaining: number; itemsPerDay: number; r2: number }
  | { ok: false; reason: string };

/**
 * Projects a completion date by least-squares fit on the burnup's completed
 * line, extrapolated to current scope.
 *
 * Refuses rather than guessing when the data cannot support a forecast. A
 * confident line through three points is worse than no line: it gets screenshot
 * into a status deck and then defended. The guards are deliberate:
 *   - fewer than `minDays` observations
 *   - a flat or negative slope (nothing is being completed; there is no date)
 *   - a poor fit (r2 below `minR2`), meaning throughput is too erratic to
 *     extrapolate honestly
 */
export function forecastFromBurnup(
  series: BurnupPoint[],
  opts: { minDays?: number; minR2?: number } = {},
): Forecast {
  const minDays = opts.minDays ?? 14;
  const minR2 = opts.minR2 ?? 0.5;

  if (series.length < minDays) {
    return { ok: false, reason: `needs ${minDays} days of history, has ${series.length}` };
  }

  const last = series[series.length - 1]!;
  const remaining = last.scope - last.completed;
  if (remaining <= 0) return { ok: false, reason: 'all known scope is already complete' };

  // x = day index, y = cumulative completed.
  const n = series.length;
  const xs = series.map((_, i) => i);
  const ys = series.map((p) => p.completed);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  if (sxx === 0) return { ok: false, reason: 'no variation in the series' };
  const slope = sxy / sxx;
  if (slope <= 0.01) {
    return { ok: false, reason: 'throughput is flat or negative; no completion date exists' };
  }

  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  if (r2 < minR2) {
    return { ok: false, reason: `fit too poor to extrapolate (r2 ${r2.toFixed(2)} < ${minR2})` };
  }

  const daysRemaining = Math.ceil(remaining / slope);
  const lastDay = new Date(`${last.day}T00:00:00Z`);
  const completion = new Date(lastDay.getTime() + daysRemaining * 86_400_000);

  return {
    ok: true,
    completionDate: completion.toISOString().slice(0, 10),
    daysRemaining,
    itemsPerDay: Math.round(slope * 100) / 100,
    r2: Math.round(r2 * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Triggers -- "what's holding us back"
// ---------------------------------------------------------------------------

export type Trigger = {
  rule: string;
  severity: 'high' | 'medium' | 'low';
  /** A sentence a PM could say out loud, with the number that fired it. */
  message: string;
  count: number;
  evidence?: { kind: 'items' | 'impediments'; ids: string[] };
};

export type TriggerThresholds = {
  /** Multiple of p85 cycle time at which an in-flight item is "stuck". */
  agingMultiple: number;
  /** In-flight items above which WIP is flagged. 0 disables. */
  wipLimit: number;
  /** Days an impediment may stay open before it is flagged. */
  impedimentAgeDays: number;
  /** Consecutive declining weeks that constitute a trend. */
  decliningWeeks: number;
};

export const DEFAULT_THRESHOLDS: TriggerThresholds = {
  agingMultiple: 1.5,
  wipLimit: 0,
  impedimentAgeDays: 14,
  decliningWeeks: 3,
};

/**
 * Evaluates the blocker rules and returns only those that fired.
 *
 * Rules are thresholds over data rather than hardcoded numbers, because a
 * one-week sprint and a two-week construction phase do not share them. Each
 * fired trigger carries the figure that fired it, so the panel reads as
 * statements rather than warnings.
 *
 * Reads `status_category`, never status labels: "Awaiting inspection" is a
 * construction term mapped to the `in_review` category, and these rules have to
 * fire on it without knowing the word exists.
 */
export async function triggers(
  asOf: Date,
  scope: Scope = {},
  thresholds: Partial<TriggerThresholds> = {},
): Promise<Trigger[]> {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const out: Trigger[] = [];

  const [cycle, aging, flow, tput] = await Promise.all([
    cycleTime(asOf, scope),
    agingWip(asOf, scope),
    sql<{ count: number; oldestDays: number | null }[]>`
      select count(*)::int as "count",
             round(max(extract(epoch from (${ts(asOf)}::timestamptz - i.opened_at)) / 86400)::numeric, 0)::float8
               as "oldestDays"
      from impediments i
      where i.resolved_at is null
        and i.opened_at <= ${ts(asOf)}::timestamptz
        and (${scope.projectId ? sql`i.project_id = ${scope.projectId}` : sql`true`})
    `,
    throughput(asOf, scope, t.decliningWeeks + 2),
  ]);

  // -- items stuck well past the normal cycle time -------------------------
  if (cycle.p85Days && aging.length) {
    const limit = cycle.p85Days * t.agingMultiple;
    const stuck = aging.filter((a) => a.ageDays > limit);
    if (stuck.length) {
      out.push({
        rule: 'aging-wip',
        severity: stuck.length > 5 ? 'high' : 'medium',
        message:
          `${stuck.length} item${stuck.length === 1 ? '' : 's'} in flight longer than ` +
          `${limit.toFixed(0)} days (${t.agingMultiple}x the ${cycle.p85Days}-day 85th percentile). ` +
          `Oldest: ${stuck[0]!.key} at ${stuck[0]!.ageDays} days.`,
        count: stuck.length,
        evidence: { kind: 'items', ids: stuck.slice(0, 20).map((s) => s.id) },
      });
    }
  }

  // -- blocked work --------------------------------------------------------
  const blocked = aging.filter((a) => a.isBlocked);
  if (blocked.length) {
    out.push({
      rule: 'blocked-items',
      severity: blocked.length > 10 ? 'high' : 'medium',
      message:
        `${blocked.length} in-flight item${blocked.length === 1 ? ' is' : 's are'} blocked, ` +
        `the longest for ${Math.max(...blocked.map((b) => b.ageDays))} days.`,
      count: blocked.length,
      evidence: { kind: 'items', ids: blocked.slice(0, 20).map((b) => b.id) },
    });
  }

  // -- long-open impediments ----------------------------------------------
  const imp = flow[0];
  if (imp && imp.count > 0 && (imp.oldestDays ?? 0) > t.impedimentAgeDays) {
    out.push({
      rule: 'stale-impediment',
      severity: 'high',
      message:
        `${imp.count} open impediment${imp.count === 1 ? '' : 's'}, the oldest unresolved for ` +
        `${imp.oldestDays} days (threshold ${t.impedimentAgeDays}).`,
      count: imp.count,
    });
  }

  // -- WIP above the limit -------------------------------------------------
  if (t.wipLimit > 0 && aging.length > t.wipLimit) {
    out.push({
      rule: 'wip-limit',
      severity: 'medium',
      message: `${aging.length} items in flight against a limit of ${t.wipLimit}. Finishing beats starting.`,
      count: aging.length,
    });
  }

  // -- declining throughput ------------------------------------------------
  // Ignores the current partial week, which is always lower and would otherwise
  // report a decline every Monday.
  const closed = tput.slice(0, -1);
  if (closed.length > t.decliningWeeks) {
    const tail = closed.slice(-t.decliningWeeks);
    const falling = tail.every((b, i) => i === 0 || b.completed < tail[i - 1]!.completed);
    if (falling && tail[0]!.completed > 0) {
      out.push({
        rule: 'declining-throughput',
        severity: 'medium',
        message:
          `Throughput has fallen ${t.decliningWeeks} weeks running: ` +
          `${tail.map((b) => b.completed).join(' -> ')} items per week.`,
        count: t.decliningWeeks,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export type DashboardSnapshot = {
  asOf: string;
  wip: WipSummary;
  cycle: DurationStats;
  lead: DurationStats;
  throughput: ThroughputBucket[];
  velocity: VelocityBucket[];
  flow: FlowDay[];
  aging: AgingItem[];
  burnup: BurnupPoint[];
  forecast: Forecast;
  triggers: Trigger[];
};

/**
 * Everything the dashboard renders, in one round trip's worth of parallel
 * queries. Grouped here so a view cannot accidentally compute a metric a
 * different way than the one in docs/METRICS.md.
 */
export async function dashboardSnapshot(asOf: Date, scope: Scope = {}): Promise<DashboardSnapshot> {
  const [wip, cycle, lead, tput, vel, flow, aging, burn, trig] = await Promise.all([
    wipSummary(asOf, scope),
    cycleTime(asOf, scope),
    leadTime(asOf, scope),
    throughput(asOf, scope),
    velocity(asOf, scope),
    cumulativeFlow(asOf, scope),
    agingWip(asOf, scope),
    burnup(asOf, scope),
    triggers(asOf, scope),
  ]);

  return {
    asOf: asOf.toISOString(),
    wip,
    cycle,
    lead,
    throughput: tput,
    velocity: vel,
    flow,
    aging,
    burnup: burn,
    forecast: forecastFromBurnup(burn),
    triggers: trig,
  };
}
