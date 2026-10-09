/**
 * Metric definitions, asserted against the pinned-clock `construction` fixture.
 *
 * Two kinds of assertion here, deliberately mixed:
 *
 *  - **Exact values** for the headline numbers, so a changed definition fails a
 *    test rather than quietly redrawing a chart.
 *  - **Relationships and invariants** for everything else -- lead >= cycle,
 *    median <= p85, buckets gap-filled, group items excluded. These survive a
 *    legitimate fixture change and still catch a wrong definition, which is
 *    what you actually want from most of a suite.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../packages/db/src/client';
import * as q from '../../packages/db/src/queries/index';
import { EXPECTED_METRICS as M, EXPECTED_TOTALS as T, PINNED_NOW } from '../fixtures';

const asOf = PINNED_NOW;

describe('fixture shape', () => {
  it('holds the expected row counts', async () => {
    const [row] = await sql<
      [{ leaf: number; group: number; tr: number; imp: number; proj: number }]
    >`
      select
        (select count(*) from work_items where not ('group' = any(labels)))::int as "leaf",
        (select count(*) from work_items where      ('group' = any(labels)))::int as "group",
        (select count(*) from status_transitions)::int as "tr",
        (select count(*) from impediments)::int as "imp",
        (select count(*) from projects)::int as "proj"
    `;
    expect(row).toEqual({
      leaf: T.leafItems,
      group: T.groupItems,
      tr: T.transitions,
      imp: T.impediments,
      proj: T.projects,
    });
  });
});

describe('cycle and lead time', () => {
  it('matches the pinned values', async () => {
    expect(await q.cycleTime(asOf)).toEqual(M.cycle);
    expect(await q.leadTime(asOf)).toEqual(M.lead);
  });

  it('reports lead time at least as long as cycle time', async () => {
    // Lead includes the queue before anyone started, so it cannot be shorter.
    // If this ever inverts, one of the two is measuring from the wrong column.
    const [c, l] = await Promise.all([q.cycleTime(asOf), q.leadTime(asOf)]);
    expect(l.medianDays!).toBeGreaterThanOrEqual(c.medianDays!);
    expect(l.p85Days!).toBeGreaterThanOrEqual(c.p85Days!);
  });

  it('puts the 85th percentile above the median', async () => {
    const c = await q.cycleTime(asOf);
    expect(c.p85Days!).toBeGreaterThan(c.medianDays!);
  });

  it('measures lead time from source_created_at, not created_at', async () => {
    // created_at is the seed run's wall clock; source_created_at is the
    // generated history. Measuring from the wrong one gives near-zero lead
    // times, so this asserts the gap is real rather than trusting the column
    // name. (The schema comment named the wrong column once already.)
    const [row] = await sql<[{ fromSource: number; fromRow: number }]>`
      select
        round(avg(extract(epoch from (completed_at - source_created_at)) / 86400)::numeric, 1)::float8
          as "fromSource",
        round(avg(extract(epoch from (completed_at - created_at)) / 86400)::numeric, 1)::float8
          as "fromRow"
      from work_items
      where completed_at is not null and not ('group' = any(labels))
    `;
    expect(row.fromSource).toBeGreaterThan(1);
    // Rows were inserted after the history they describe, so this is negative.
    expect(row.fromRow).toBeLessThan(0);
  });

  it('excludes group containers from the statistics', async () => {
    // Containers span the whole project; including them would inflate both.
    const withGroups = await sql<[{ n: number }]>`
      select count(*)::int as "n" from work_items wi
      where wi.completed_at is not null and wi.started_at is not null
    `;
    const leafOnly = await q.cycleTime(asOf);
    expect(leafOnly.n).toBeLessThanOrEqual(withGroups[0].n);
  });

  it('narrows when scoped to one project', async () => {
    const all = await q.cycleTime(asOf);
    const projects = await q.listProjects();
    const one = await q.cycleTime(asOf, { projectId: projects[0]!.id });
    expect(one.n).toBeGreaterThan(0);
    expect(one.n).toBeLessThan(all.n);
  });
});

describe('wip summary', () => {
  it('matches the pinned values', async () => {
    expect(await q.wipSummary(asOf)).toEqual(M.wip);
  });

  it('agrees with the aging list on how much is in flight', async () => {
    // Two different queries answering the same question. They drifted apart
    // once before, between work_items and status_transitions, and produced a
    // dashboard that contradicted itself.
    const [wip, aging] = await Promise.all([q.wipSummary(asOf), q.agingWip(asOf)]);
    expect(aging.length).toBe(wip.inFlight);
  });

  it('agrees with transition history on the blocked count', async () => {
    const wip = await q.wipSummary(asOf);
    const [row] = await sql<[{ n: number }]>`
      select count(distinct st.work_item_id)::int as "n"
      from status_transitions st
      where st.to_category = 'blocked'
        and st.id = (select max(x.id) from status_transitions x where x.work_item_id = st.work_item_id)
    `;
    expect(row.n).toBe(wip.blocked);
  });
});

describe('throughput', () => {
  it('gap-fills every week in the window', async () => {
    const weeks = 12;
    const buckets = await q.throughput(asOf, {}, weeks);
    expect(buckets.length).toBe(weeks + 1);
    // Strictly ascending, exactly 7 days apart, no holes.
    for (let i = 1; i < buckets.length; i++) {
      const prev = new Date(`${buckets[i - 1]!.weekStart}T00:00:00Z`).getTime();
      const cur = new Date(`${buckets[i]!.weekStart}T00:00:00Z`).getTime();
      expect(cur - prev).toBe(7 * 86_400_000);
    }
    expect(buckets.every((b) => Number.isInteger(b.completed) && b.completed >= 0)).toBe(true);
  });

  it('counts every completion in the window exactly once', async () => {
    const buckets = await q.throughput(asOf, {}, 12);
    const summed = buckets.reduce((a, b) => a + b.completed, 0);
    const [row] = await sql<[{ n: number }]>`
      select count(*)::int as "n" from work_items wi
      where not ('group' = any(wi.labels))
        and wi.completed_at is not null
        and wi.completed_at <= ${asOf.toISOString()}::timestamptz
        and wi.completed_at >= ${new Date(asOf.getTime() - 84 * 86_400_000).toISOString()}::timestamptz
    `;
    expect(summed).toBe(row.n);
  });
});

describe('velocity', () => {
  it('only reports closed iterations', async () => {
    // An in-flight iteration always looks like a velocity collapse.
    const vel = await q.velocity(asOf);
    expect(vel.length).toBeGreaterThan(0);
    for (const v of vel) {
      expect(new Date(`${v.endDate}T00:00:00Z`).getTime()).toBeLessThan(asOf.getTime());
      expect(v.state).toBe('closed');
    }
  });

  it('returns oldest first so a chart reads left to right', async () => {
    const vel = await q.velocity(asOf);
    const dates = vel.map((v) => v.endDate);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('cumulative flow', () => {
  it('covers every day in the window', async () => {
    const days = 30;
    const flow = await q.cumulativeFlow(asOf, {}, days);
    const unique = [...new Set(flow.map((f) => f.day))];
    expect(unique.length).toBe(days + 1);
    expect(unique).toEqual([...unique].sort());
  });

  it('accounts for every item that existed on a given day', async () => {
    // An item is in exactly one category at a time, so the stacked total for a
    // day must equal the number of items created by then. A reconstruction that
    // double-counts or drops items shows up here as a mismatch.
    const flow = await q.cumulativeFlow(asOf, {}, 30);
    const lastDay = [...new Set(flow.map((f) => f.day))].at(-1)!;
    const stacked = flow.filter((f) => f.day === lastDay).reduce((a, f) => a + f.count, 0);

    const [row] = await sql<[{ n: number }]>`
      select count(*)::int as "n" from work_items wi
      where not ('group' = any(wi.labels))
        and wi.source_created_at <= ${lastDay}::date + interval '1 day' - interval '1 microsecond'
    `;
    expect(stacked).toBe(row.n);
  });

  it("ends on today's actual distribution", async () => {
    const flow = await q.cumulativeFlow(asOf, {}, 30);
    const lastDay = [...new Set(flow.map((f) => f.day))].at(-1)!;
    const byCat = Object.fromEntries(
      flow.filter((f) => f.day === lastDay).map((f) => [f.category, f.count]),
    );
    expect(byCat.done).toBe(M.wip.done);
    expect(byCat.blocked).toBe(M.wip.blocked);
  });
});

describe('aging wip', () => {
  it('is ordered oldest first', async () => {
    const aging = await q.agingWip(asOf);
    const ages = aging.map((a) => a.ageDays);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  });

  it('contains only started, unfinished work', async () => {
    const aging = await q.agingWip(asOf);
    expect(aging.length).toBeGreaterThan(0);
    for (const a of aging) {
      // Zero is valid -- an item started today has not aged yet. Negative
      // would mean a start date in the future, which is what this guards.
      expect(a.ageDays).toBeGreaterThanOrEqual(0);
      expect(a.statusCategory).not.toBe('done');
      expect(a.statusCategory).not.toBe('cancelled');
    }
  });

  it('keeps most in-flight work recent, with a thin stalled tail', async () => {
    // The fixture used to spread unfinished work uniformly over six months,
    // which made the aging trigger fire on 85% of the board. Real WIP is mostly
    // recent; the tail is what the trigger should be finding.
    const aging = await q.agingWip(asOf);
    const stalled = aging.filter((a) => a.ageDays > 60);
    expect(stalled.length / aging.length).toBeLessThan(0.15);
    expect(stalled.length).toBeGreaterThan(0);
  });
});

describe('burnup and forecast', () => {
  it('matches the pinned final point', async () => {
    const series = await q.burnup(asOf);
    const last = series.at(-1)!;
    expect(last.completed).toBe(M.burnupFinal.completed);
    expect(last.scope).toBe(M.burnupFinal.scope);
  });

  it('is monotonic in both lines', async () => {
    // Cumulative series cannot decrease. If either does, the window or the
    // comparison boundary is wrong.
    const series = await q.burnup(asOf);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.completed).toBeGreaterThanOrEqual(series[i - 1]!.completed);
      expect(series[i]!.scope).toBeGreaterThanOrEqual(series[i - 1]!.scope);
    }
  });

  it('never shows completed above scope', async () => {
    const series = await q.burnup(asOf);
    for (const p of series) expect(p.completed).toBeLessThanOrEqual(p.scope);
  });

  it('forecasts the pinned completion date', async () => {
    const f = q.forecastFromBurnup(await q.burnup(asOf));
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.completionDate).toBe(M.forecastCompletionDate);
  });
});

describe('triggers', () => {
  let fired: Awaited<ReturnType<typeof q.triggers>>;
  beforeAll(async () => {
    fired = await q.triggers(asOf);
  });

  it('fires on the fixture and sorts most severe first', () => {
    expect(fired.length).toBeGreaterThan(0);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ranks = fired.map((t) => rank[t.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('stays actionable rather than flagging most of the board', () => {
    // A trigger that fires on everything is noise. Issue #28 asks for signal.
    const aging = fired.find((t) => t.rule === 'aging-wip');
    expect(aging).toBeDefined();
    expect(aging!.count).toBeLessThan(40);
    expect(aging!.count).toBeGreaterThan(0);
  });

  it('quotes the number that fired it in every message', () => {
    for (const t of fired) expect(t.message).toMatch(/\d/);
  });

  it('fires on status category, not on preset-specific labels', () => {
    // "Awaiting inspection" is a construction term mapped to in_review. The
    // rules must work without knowing the word exists.
    for (const t of fired) {
      expect(t.message).not.toMatch(/Awaiting inspection|Not started|Scheduled/);
    }
  });

  it('respects caller thresholds', async () => {
    const strict = await q.triggers(asOf, {}, { impedimentAgeDays: 1, wipLimit: 1 });
    const loose = await q.triggers(asOf, {}, { impedimentAgeDays: 9999, wipLimit: 0 });
    expect(strict.length).toBeGreaterThan(loose.length);
    expect(loose.some((t) => t.rule === 'stale-impediment')).toBe(false);
    expect(strict.some((t) => t.rule === 'wip-limit')).toBe(true);
  });
});

describe('project summaries', () => {
  it('orders by risk, worst first', async () => {
    const summaries = await q.projectSummaries(asOf);
    expect(summaries.map((s) => s.key)).toEqual([...M.riskOrder]);
    const risks = summaries.map((s) => s.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
  });

  it('reports percentages within range and counts that add up', async () => {
    for (const s of await q.projectSummaries(asOf)) {
      expect(s.percentComplete).toBeGreaterThanOrEqual(0);
      expect(s.percentComplete).toBeLessThanOrEqual(100);
      expect(s.done + s.inFlight).toBeLessThanOrEqual(s.total);
      expect(s.risk).toBeGreaterThanOrEqual(0);
      expect(s.risk).toBeLessThanOrEqual(100);
    }
  });

  it('sums to the portfolio-wide totals', async () => {
    const summaries = await q.projectSummaries(asOf);
    const wip = await q.wipSummary(asOf);
    expect(summaries.reduce((a, s) => a + s.total, 0)).toBe(T.leafItems);
    expect(summaries.reduce((a, s) => a + s.done, 0)).toBe(wip.done);
    expect(summaries.reduce((a, s) => a + s.inFlight, 0)).toBe(wip.inFlight);
  });
});

describe('preset vocabulary', () => {
  it('reports the construction labels, not software defaults', async () => {
    // The genericity guarantee, asserted rather than reviewed: nothing in the
    // UI should be able to render "Sprint" against this fixture.
    const labels = await q.getLabels();
    expect(await q.getActivePreset()).toBe('construction');
    expect(labels.iteration).toBe('Phase');
    expect(labels.portfolio).toBe('Programme');
    expect(labels.workItem).toBe('Work item');
    expect(labels.estimateUnit).toBe('days');
  });

  it('maps a domain-specific status onto a generic category', async () => {
    // "Awaiting inspection" -> in_review is the bridge that lets every flow
    // metric work for a domain whose vocabulary this code has never seen.
    const [row] = await sql<[{ category: string }]>`
      select tt.status_category::text as "category"
      from taxonomy_terms tt join taxonomies t on t.id = tt.taxonomy_id
      where t.key = 'workflow_status' and tt.label = 'Awaiting inspection'
    `;
    expect(row.category).toBe('in_review');
  });
});
