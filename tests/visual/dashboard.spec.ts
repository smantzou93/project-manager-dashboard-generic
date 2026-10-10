import { expect, test } from '@playwright/test';

import { EXPECTED_METRICS as M } from '../fixtures';
import { capture, settle, tileValue } from './_helpers';

/**
 * Every spec pairs a pixel comparison with functional assertions.
 *
 * A screenshot test on its own tells you *that* something changed and never
 * *what* broke -- you get a red diff and still have to go looking. The
 * assertions name the failure; the image shows it.
 */
test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await settle(page);
  });

  test('renders the KPI tiles from the pinned fixture', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    expect(await tileValue(page, 'In flight')).toContain(String(M.wip.inFlight));
    expect(await tileValue(page, 'Blocked')).toContain(String(M.wip.blocked));
    expect(await tileValue(page, 'Completed')).toContain(String(M.wip.done));
    // The tile rounds for display; assert the rendered form, still derived
    // from the fixture so the two cannot drift apart.
    expect(await tileValue(page, 'Cycle time')).toContain(M.cycle.medianDays.toFixed(1));
  });

  test('renders every chart with an accessible name and a data table', async ({ page }) => {
    for (const name of [/Throughput\./, /Velocity\./, /Cumulative flow\./, /Burnup\./]) {
      await expect(page.getByRole('img', { name })).toBeVisible();
    }
    // The numbers behind each chart must be reachable as a real table, not
    // only as pixels. Four charts, four tables.
    await expect(page.locator('table.visually-hidden')).toHaveCount(4);
  });

  test('states a definition beside every chart', async ({ page }) => {
    // A number a viewer cannot interrogate gets mistrusted. Every panel says
    // what it means, so the meeting is about the work and not the metric.
    const panels = page.locator('.card > h2');
    const count = await panels.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const defn = panels.nth(i).locator('+ .defn');
      await expect(defn).toBeVisible();
      expect((await defn.textContent())?.length ?? 0).toBeGreaterThan(30);
    }
  });

  test('uses the preset vocabulary and never software defaults', async ({ page }) => {
    // The genericity guarantee, asserted against rendered output rather than
    // against the data model. If a component ever hardcodes a noun, this fails.
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).toContain('Phase');
    expect(body).toContain('Work item');
    expect(body).not.toContain('Sprint');
    expect(body).not.toContain('story point');
  });

  test('ranks triggers most severe first', async ({ page }) => {
    const triggers = page.locator('.trigger');
    await expect(triggers.first()).toBeVisible();
    // evaluateAll's callback is typed loosely at the browser boundary, so the
    // element type is stated explicitly rather than inferred as `any`.
    const classes = await triggers.evaluateAll((els: Element[]) =>
      els.map((e) => (e.className.match(/trigger-(high|medium|low)/) ?? [])[1] ?? ''),
    );
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const ranks = classes.map((c) => rank[c] ?? 9);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test('visual', { tag: '@pixel' }, async ({ page }) => {
    await capture(page, 'dashboard');
  });
});
