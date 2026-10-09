import { expect, test } from '@playwright/test';

import { EXPECTED_METRICS as M } from '../fixtures';
import { capture, settle } from './_helpers';

test.describe('multi-project view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await settle(page);
  });

  test('orders projects by risk, worst first', async ({ page }) => {
    // The single most important behaviour on this page. A portfolio view that
    // has to be scanned has failed at its job.
    const keys = await page.locator('table.data tbody tr td:first-child strong').allTextContents();
    expect(keys).toEqual([...M.riskOrder]);
  });

  test('links each row through to the project view', async ({ page }) => {
    const first = page.locator('table.data tbody tr').first();
    await first.locator('a').first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${M.riskOrder[0]}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(M.riskOrder[0]);
  });

  test('labels the portfolio column with the preset noun', async ({ page }) => {
    // "Programme" for construction, not "Portfolio".
    await expect(page.getByRole('columnheader', { name: 'Programme' })).toBeVisible();
  });

  test('visual', async ({ page }) => {
    await capture(page, 'projects');
  });
});

test.describe('single project view', () => {
  test('answers whether it will land on time, in words', async ({ page }) => {
    await page.goto(`/projects/${M.riskOrder[0]}`);
    await settle(page);
    const verdict = page.locator('.card', { hasText: 'Will it land on time?' });
    await expect(verdict).toBeVisible();
    // Not a chart to interpret -- a sentence, with a date in it.
    await expect(verdict.locator('.badge')).toContainText(/target|Projected|No forecast/);
  });

  test('stays useful for a team that records no estimates', async ({ page }) => {
    await page.goto(`/projects/${M.riskOrder[0]}`);
    await settle(page);
    // Counts, not points, carry the view. Both tiles must have real values.
    await expect(page.locator('.tile', { hasText: 'Complete' })).toContainText('%');
    await expect(page.locator('.tile', { hasText: 'In flight' })).toBeVisible();
  });

  test('404s on an unknown key, and renders the page', async ({ page }) => {
    // Both halves matter and they fail independently. The status is what a
    // crawler, a monitor and a fetch() key off; the body is what a person
    // sees.
    //
    // The body is NOT in the server-rendered HTML -- it streams into the
    // flight payload and commits on the client. Checking this with curl will
    // suggest it is broken, which is exactly the wrong conclusion drawn once
    // before (issue #44). It only renders when hydration works, so this also
    // guards the allowedDevOrigins setting that silently disables it.
    const res = await page.goto('/projects/DOES-NOT-EXIST');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });

  test('visual', async ({ page }) => {
    await page.goto(`/projects/${M.riskOrder[0]}`);
    await capture(page, 'project-detail');
  });
});
