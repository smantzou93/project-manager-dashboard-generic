import { expect, test } from '@playwright/test';

/**
 * Does client-side React work at all?
 *
 * A trivial client component: if this is not interactive, no interactive UI in
 * the app can be, and the cause is the framework or the install rather than
 * any application code.
 */
test('a client component hydrates and becomes interactive', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/hydration-probe');

  // The effect only runs after hydration, so this is the honest signal.
  await expect(page.locator('#probe-mounted')).toHaveText('effect-ran: true', { timeout: 10_000 });

  await page.locator('#probe-button').click();
  await expect(page.locator('#probe-button')).toHaveText('count: 1');

  expect(errors.filter((e) => !e.includes('hmr') && !e.includes('WebSocket'))).toEqual([]);
});
