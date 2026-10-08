import { describe, expect, it } from 'vitest';

import { forecastFromBurnup, type BurnupPoint } from '../../packages/db/src/queries/metrics.js';

/** A burnup where `completed` advances by exactly `perDay` each day. */
function linearBurnup(days: number, perDay: number, scope: number): BurnupPoint[] {
  const out: BurnupPoint[] = [];
  const start = Date.UTC(2026, 6, 1);
  for (let i = 0; i < days; i++) {
    out.push({
      day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      completed: Math.min(scope, Math.round(i * perDay)),
      scope,
    });
  }
  return out;
}

describe('forecastFromBurnup', () => {
  it('projects a completion date from a clean linear trend', () => {
    // 30 days at 2/day = 60 done, 100 scope, 40 remaining -> 20 more days.
    const f = forecastFromBurnup(linearBurnup(31, 2, 100));
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.itemsPerDay).toBeCloseTo(2, 1);
    expect(f.daysRemaining).toBe(20);
    expect(f.completionDate).toBe('2026-08-20');
    expect(f.r2).toBeGreaterThan(0.99);
  });

  // The guards below are the point of this function. A forecast is the number
  // most likely to be screenshot into a status deck and then defended, so
  // refusing is the correct behaviour far more often than it feels like.

  it('refuses when there is too little history', () => {
    const f = forecastFromBurnup(linearBurnup(5, 2, 100));
    expect(f.ok).toBe(false);
    if (f.ok) return;
    expect(f.reason).toMatch(/needs 14 days/);
  });

  it('refuses when nothing is being completed', () => {
    // A flat line has no completion date. Reporting one would be invention.
    const flat = linearBurnup(30, 0, 100);
    const f = forecastFromBurnup(flat);
    expect(f.ok).toBe(false);
    if (f.ok) return;
    expect(f.reason).toMatch(/flat or negative/);
  });

  it('refuses when throughput is too erratic to extrapolate', () => {
    // Completed jumps around with no trend: a line through it would be a lie
    // with a confident slope.
    const noisy = linearBurnup(40, 2, 200).map((p, i) => ({
      ...p,
      completed: [10, 90, 20, 80, 30, 70][i % 6]!,
    }));
    const f = forecastFromBurnup(noisy);
    expect(f.ok).toBe(false);
    if (f.ok) return;
    expect(f.reason).toMatch(/fit too poor/);
  });

  it('refuses when all known scope is already done', () => {
    const f = forecastFromBurnup(linearBurnup(30, 2, 20));
    expect(f.ok).toBe(false);
    if (f.ok) return;
    expect(f.reason).toMatch(/already complete/);
  });

  it('honours caller-supplied thresholds', () => {
    const series = linearBurnup(20, 2, 100);
    expect(forecastFromBurnup(series, { minDays: 30 }).ok).toBe(false);
    expect(forecastFromBurnup(series, { minDays: 10 }).ok).toBe(true);
  });

  it('never projects a date in the past', () => {
    const f = forecastFromBurnup(linearBurnup(31, 2, 100));
    if (!f.ok) throw new Error('expected a forecast');
    expect(new Date(f.completionDate).getTime()).toBeGreaterThan(
      new Date('2026-07-31').getTime(),
    );
    expect(f.daysRemaining).toBeGreaterThan(0);
  });
});
