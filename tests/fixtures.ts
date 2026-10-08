/**
 * Constants shared by the unit, integration and visual suites.
 *
 * The pinned instant is the single most important value in the test setup.
 * Every date in the seeded database is generated relative to it, and every
 * metric is computed `asOf` it, so the whole suite -- including the screenshot
 * baselines -- is reproducible on any machine on any day.
 *
 * Changing it invalidates every committed screenshot and every asserted number
 * below, so don't, unless that is the intent.
 */

/** The frozen "now" for all deterministic tests. */
export const PINNED_NOW_ISO = '2026-10-01T12:00:00Z';
export const PINNED_NOW = new Date(PINNED_NOW_ISO);

/** The preset the deterministic fixtures are built from. */
export const FIXTURE_PRESET = 'construction';

/**
 * Totals the seed produces for `construction` at the pinned instant.
 * Asserted directly, so a change to the generator is caught here rather than
 * showing up as an unexplained screenshot diff.
 */
export const EXPECTED_TOTALS = {
  projects: 6,
  /** Leaf items. The 24 group containers are excluded from aggregates. */
  leafItems: 645,
  groupItems: 24,
  transitions: 2029,
  impediments: 24,
} as const;

/**
 * Metric values at `PINNED_NOW` for the `construction` fixture.
 *
 * Exact on purpose. These are the numbers a chart would render, so pinning them
 * means a changed metric definition fails a test instead of silently redrawing
 * a dashboard. When one of these legitimately changes, the diff is the record
 * of what changed and why.
 */
export const EXPECTED_METRICS = {
  wip: { inFlight: 147, blocked: 22, todo: 96, done: 394 },
  cycle: { n: 394, medianDays: 4.17, p85Days: 11.28 },
  lead: { n: 394, medianDays: 9.33, p85Days: 16.22 },
  burnupFinal: { completed: 394, scope: 645 },
  forecastCompletionDate: '2027-01-12',
  /** Multi-project view ordering, worst first. The default sort's whole point. */
  riskOrder: ['WAREHOUSE', 'DEPOT', 'RIVER', 'MARKET', 'CAMPUS', 'BRIDGE'],
} as const;
