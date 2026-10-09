import { expect, test } from '@playwright/test';

import { capture, settle } from './_helpers';

/**
 * Dark mode is not decoration here. These views get screenshotted into decks
 * and read on laptops at whatever the OS is set to, and the chart palette is
 * defined per theme rather than derived -- blocked has to read as a problem in
 * both. A separate baseline is the only way to catch a token that was only
 * fixed in one.
 */
test.describe('dark theme', () => {
  test('keeps chart categories distinguishable', async ({ page }) => {
    await page.goto('/dashboard');
    await settle(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Dark background actually applied, rather than the light tokens leaking.
    const [r, g, b] = bg.match(/\d+/g)!.map(Number) as [number, number, number];
    expect((r + g + b) / 3).toBeLessThan(80);

    const blocked = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--c-blocked').trim(),
    );
    expect(blocked).not.toBe('');
  });

  test('visual', async ({ page }) => {
    await page.goto('/dashboard');
    await capture(page, 'dashboard-dark');
  });
});
