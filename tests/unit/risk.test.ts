import { describe, expect, it } from 'vitest';

import { riskScore } from '../../packages/db/src/queries/projects';

const asOf = new Date('2026-10-01T12:00:00Z');

const clean = {
  forecastSlipDays: 0,
  blocked: 0,
  inFlight: 10,
  openImpediments: 0,
  oldestInFlightDays: 3,
  percentComplete: 50,
  targetDate: '2026-12-01',
  asOf,
};

describe('riskScore', () => {
  it('scores a healthy project near zero', () => {
    expect(riskScore(clean)).toBeLessThanOrEqual(5);
  });

  it('stays within 0-100 under every extreme', () => {
    const worst = riskScore({
      forecastSlipDays: 9999,
      blocked: 100,
      inFlight: 100,
      openImpediments: 50,
      oldestInFlightDays: 999,
      percentComplete: 0,
      targetDate: '2020-01-01',
      asOf,
    });
    expect(worst).toBe(100);
    expect(riskScore(clean)).toBeGreaterThanOrEqual(0);
  });

  // The ordering claim in the docstring -- "things that are already true
  // outrank things that are predicted, and a forecast slip is the strongest
  // single signal" -- is the actual contract. If the weights get retuned, these
  // comparisons are what should force the docstring to be updated too.
  it('ranks a forecast slip above an equivalent count of impediments', () => {
    const slipping = riskScore({ ...clean, forecastSlipDays: 30 });
    const impeded = riskScore({ ...clean, openImpediments: 3 });
    expect(slipping).toBeGreaterThan(impeded);
  });

  it('treats a missing forecast as a mild signal, not a clean bill of health', () => {
    const noForecast = riskScore({ ...clean, forecastSlipDays: null });
    expect(noForecast).toBeGreaterThan(riskScore(clean));
    // ...but far below an actual slip.
    expect(noForecast).toBeLessThan(riskScore({ ...clean, forecastSlipDays: 30 }));
  });

  it('scales blocked work by share of WIP, not absolute count', () => {
    // 5 blocked of 10 in flight is a worse situation than 5 of 100.
    const concentrated = riskScore({ ...clean, blocked: 5, inFlight: 10 });
    const diluted = riskScore({ ...clean, blocked: 5, inFlight: 100 });
    expect(concentrated).toBeGreaterThan(diluted);
  });

  it('penalises an overdue, unfinished project', () => {
    const overdue = riskScore({ ...clean, targetDate: '2026-01-01', percentComplete: 40 });
    expect(overdue).toBeGreaterThanOrEqual(riskScore(clean) + 20);
  });

  it('does not penalise a finished project past its target date', () => {
    const done = riskScore({ ...clean, targetDate: '2026-01-01', percentComplete: 100 });
    expect(done).toBe(riskScore({ ...clean, percentComplete: 100 }));
  });

  it('ignores aging below the two-week grace period', () => {
    expect(riskScore({ ...clean, oldestInFlightDays: 10 })).toBe(
      riskScore({ ...clean, oldestInFlightDays: 1 }),
    );
    expect(riskScore({ ...clean, oldestInFlightDays: 60 })).toBeGreaterThan(
      riskScore({ ...clean, oldestInFlightDays: 10 }),
    );
  });

  it('produces a strict ordering across a realistic spread', () => {
    const scores = [
      riskScore(clean),
      riskScore({ ...clean, openImpediments: 2 }),
      riskScore({ ...clean, openImpediments: 2, blocked: 3 }),
      riskScore({ ...clean, openImpediments: 2, blocked: 3, forecastSlipDays: 20 }),
    ];
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores).size).toBe(scores.length);
  });
});
