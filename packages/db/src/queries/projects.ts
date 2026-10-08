/**
 * Project and portfolio reads, including the risk-ranked roll-up the
 * multi-project view is built on.
 */

import { sql } from '../client.js';
import { burnup, forecastFromBurnup, type Forecast } from './metrics.js';
import { ts, type Scope } from './scope.js';

export type ProjectRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  portfolioId: string | null;
  portfolioName: string | null;
  status: string | null;
  statusCategory: string | null;
  health: string | null;
  healthColor: string | null;
  owner: string | null;
  startDate: string | null;
  targetDate: string | null;
  actualEndDate: string | null;
};

export async function listProjects(): Promise<ProjectRow[]> {
  return sql<ProjectRow[]>`
    select p.id, p.key, p.name, p.description,
           p.portfolio_id as "portfolioId",
           pf.name as "portfolioName",
           st.label as "status", st.status_category::text as "statusCategory",
           ht.label as "health", ht.color as "healthColor",
           pe.display_name as "owner",
           p.start_date as "startDate", p.target_date as "targetDate",
           p.actual_end_date as "actualEndDate"
    from projects p
      left join portfolios pf on pf.id = p.portfolio_id
      left join taxonomy_terms st on st.id = p.status_term_id
      left join taxonomy_terms ht on ht.id = p.health_term_id
      left join people pe on pe.id = p.owner_id
    order by p.key
  `;
}

export async function getProject(key: string): Promise<ProjectRow | null> {
  const [row] = await sql<ProjectRow[]>`
    select p.id, p.key, p.name, p.description,
           p.portfolio_id as "portfolioId",
           pf.name as "portfolioName",
           st.label as "status", st.status_category::text as "statusCategory",
           ht.label as "health", ht.color as "healthColor",
           pe.display_name as "owner",
           p.start_date as "startDate", p.target_date as "targetDate",
           p.actual_end_date as "actualEndDate"
    from projects p
      left join portfolios pf on pf.id = p.portfolio_id
      left join taxonomy_terms st on st.id = p.status_term_id
      left join taxonomy_terms ht on ht.id = p.health_term_id
      left join people pe on pe.id = p.owner_id
    where p.key = ${key}
  `;
  return row ?? null;
}

export type ProjectSummary = ProjectRow & {
  total: number;
  done: number;
  inFlight: number;
  blocked: number;
  openImpediments: number;
  percentComplete: number;
  /** Oldest in-flight item's age, in days. The earliest warning sign there is. */
  oldestInFlightDays: number | null;
  forecast: Forecast;
  /** Days between the forecast completion date and the target date. */
  forecastSlipDays: number | null;
  /** Composite 0-100. Higher is worse. See `riskScore` for the weighting. */
  risk: number;
};

/**
 * Sums the risk signals into one orderable number.
 *
 * The weighting is a judgement call, stated here rather than buried so it can
 * be argued with and tuned. The ordering principle: things that are already
 * true outrank things that are predicted. A forecast slip is the strongest
 * signal because it is the only one that speaks directly to the date; blocked
 * and stalled work rank next because they cause slips; raw volume ranks last
 * because a big project is not a troubled one.
 */
export function riskScore(input: {
  forecastSlipDays: number | null;
  blocked: number;
  inFlight: number;
  openImpediments: number;
  oldestInFlightDays: number | null;
  percentComplete: number;
  targetDate: string | null;
  asOf: Date;
}): number {
  let score = 0;

  // Forecast past the target date: up to 40.
  if (input.forecastSlipDays !== null && input.forecastSlipDays > 0) {
    score += Math.min(40, input.forecastSlipDays);
  }

  // No forecast at all is itself a mild signal -- usually erratic throughput.
  if (input.forecastSlipDays === null) score += 5;

  // Share of in-flight work that is blocked: up to 25.
  if (input.inFlight > 0) score += Math.min(25, (input.blocked / input.inFlight) * 25);

  // Open impediments: 4 each, up to 20.
  score += Math.min(20, input.openImpediments * 4);

  // Something stalled a long time: up to 15.
  if (input.oldestInFlightDays !== null) {
    score += Math.min(15, Math.max(0, (input.oldestInFlightDays - 14) / 4));
  }

  // Past its target date and not finished: flat 20.
  if (input.targetDate && input.percentComplete < 100) {
    const target = new Date(`${input.targetDate}T00:00:00Z`);
    if (target < input.asOf) score += 20;
  }

  return Math.round(Math.min(100, score));
}

/**
 * The multi-project roll-up, ordered by risk descending.
 *
 * Sorted by risk rather than alphabetically on purpose: a portfolio view that
 * has to be scanned has failed at its job. The top row should be the project a
 * PM would have raised in the meeting anyway.
 */
export async function projectSummaries(asOf: Date, scope: Scope = {}): Promise<ProjectSummary[]> {
  const projects = await listProjects();
  const filtered = scope.portfolioId
    ? projects.filter((p) => p.portfolioId === scope.portfolioId)
    : projects;

  const counts = await sql<
    {
      projectId: string;
      total: number;
      done: number;
      inFlight: number;
      blocked: number;
      oldestInFlightDays: number | null;
    }[]
  >`
    select wi.project_id as "projectId",
           count(*)::int as "total",
           count(*) filter (where wi.completed_at is not null and wi.completed_at <= ${ts(asOf)}::timestamptz)::int
             as "done",
           count(*) filter (
             where wi.started_at is not null and wi.started_at <= ${ts(asOf)}::timestamptz
               and wi.completed_at is null and wi.status_category <> 'cancelled'
           )::int as "inFlight",
           count(*) filter (where wi.status_category = 'blocked')::int as "blocked",
           round(max(
             case when wi.completed_at is null and wi.started_at is not null
                  then extract(epoch from (${ts(asOf)}::timestamptz - wi.started_at)) / 86400 end
           )::numeric, 1)::float8 as "oldestInFlightDays"
    from work_items wi
    where not ('group' = any(wi.labels))
    group by wi.project_id
  `;

  const imps = await sql<{ projectId: string; open: number }[]>`
    select project_id as "projectId", count(*)::int as "open"
    from impediments
    where resolved_at is null and opened_at <= ${ts(asOf)}::timestamptz
    group by project_id
  `;

  const countById = new Map(counts.map((c) => [c.projectId, c]));
  const impById = new Map(imps.map((i) => [i.projectId, i.open]));

  const summaries = await Promise.all(
    filtered.map(async (p): Promise<ProjectSummary> => {
      const c = countById.get(p.id);
      const total = c?.total ?? 0;
      const done = c?.done ?? 0;
      const inFlight = c?.inFlight ?? 0;
      const blocked = c?.blocked ?? 0;
      const openImpediments = impById.get(p.id) ?? 0;
      const percentComplete = total === 0 ? 0 : Math.round((done / total) * 100);

      const series = await burnup(asOf, { projectId: p.id });
      const forecast = forecastFromBurnup(series);

      let forecastSlipDays: number | null = null;
      if (forecast.ok && p.targetDate) {
        const predicted = new Date(`${forecast.completionDate}T00:00:00Z`);
        const target = new Date(`${p.targetDate}T00:00:00Z`);
        forecastSlipDays = Math.round((predicted.getTime() - target.getTime()) / 86_400_000);
      }

      return {
        ...p,
        total,
        done,
        inFlight,
        blocked,
        openImpediments,
        percentComplete,
        oldestInFlightDays: c?.oldestInFlightDays ?? null,
        forecast,
        forecastSlipDays,
        risk: riskScore({
          forecastSlipDays,
          blocked,
          inFlight,
          openImpediments,
          oldestInFlightDays: c?.oldestInFlightDays ?? null,
          percentComplete,
          targetDate: p.targetDate,
          asOf,
        }),
      };
    }),
  );

  return summaries.sort((a, b) => b.risk - a.risk || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Supporting reads
// ---------------------------------------------------------------------------

export type MilestoneRow = {
  id: string;
  name: string;
  dueDate: string | null;
  completedAt: Date | null;
  total: number;
  done: number;
};

export async function projectMilestones(
  asOf: Date,
  projectId: string,
): Promise<MilestoneRow[]> {
  return sql<MilestoneRow[]>`
    select m.id, m.name, m.due_date as "dueDate", m.completed_at as "completedAt",
           count(wi.id)::int as "total",
           count(wi.id) filter (where wi.completed_at is not null and wi.completed_at <= ${ts(asOf)}::timestamptz)::int
             as "done"
    from milestones m
      left join work_items wi on wi.milestone_id = m.id and not ('group' = any(wi.labels))
    where m.project_id = ${projectId}
    group by m.id, m.name, m.due_date, m.completed_at, m.sort_order
    order by m.sort_order, m.due_date
  `;
}

export type ImpedimentRow = {
  id: string;
  title: string;
  kind: string | null;
  severity: string | null;
  severityColor: string | null;
  owner: string | null;
  openedAt: Date;
  ageDays: number;
};

export async function openImpediments(
  asOf: Date,
  scope: Scope = {},
): Promise<ImpedimentRow[]> {
  return sql<ImpedimentRow[]>`
    select i.id, i.title,
           kt.label as "kind",
           st.label as "severity", st.color as "severityColor",
           pe.display_name as "owner",
           i.opened_at as "openedAt",
           round((extract(epoch from (${ts(asOf)}::timestamptz - i.opened_at)) / 86400)::numeric, 1)::float8
             as "ageDays"
    from impediments i
      left join taxonomy_terms kt on kt.id = i.kind_term_id
      left join taxonomy_terms st on st.id = i.severity_term_id
      left join people pe on pe.id = i.owner_id
    where i.resolved_at is null
      and i.opened_at <= ${ts(asOf)}::timestamptz
      and (${scope.projectId ? sql`i.project_id = ${scope.projectId}` : sql`true`})
    order by i.opened_at
  `;
}

/** Preset label vocabulary, so no view hardcodes a domain noun. */
export type Labels = {
  portfolio: string;
  project: string;
  iteration: string;
  workItem: string;
  milestone: string;
  estimateUnit: string;
  impediment: string;
};

const FALLBACK_LABELS: Labels = {
  portfolio: 'Portfolio',
  project: 'Project',
  iteration: 'Cycle',
  workItem: 'Item',
  milestone: 'Milestone',
  estimateUnit: 'points',
  impediment: 'Impediment',
};

/**
 * Reads the active preset's labels out of `app_settings`.
 *
 * Falls back to neutral English rather than throwing: a database seeded with no
 * preset should still render, just generically. Returning a partial object here
 * would mean every call site needs a `??`.
 */
export async function getLabels(): Promise<Labels> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from app_settings where key = 'labels'
  `;
  const raw = row?.value;
  if (!raw || typeof raw !== 'object') return FALLBACK_LABELS;
  // Spread over the fallback so a preset that omits a label still renders.
  return { ...FALLBACK_LABELS, ...(raw as Partial<Labels>) };
}

export async function getActivePreset(): Promise<string | null> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from app_settings where key = 'active_preset'
  `;
  return typeof row?.value === 'string' ? row.value : null;
}
