import { expect, test } from '@playwright/test';

import { capture, settle } from './_helpers';

test.describe('mobile', () => {
  test('does not scroll horizontally', async ({ page }) => {
    // The commonest responsive failure, and invisible in a desktop screenshot:
    // a wide table pushes the page sideways and every other column goes
    // off-screen.
    await page.goto('/dashboard');
    await settle(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('visual', { tag: '@pixel' }, async ({ page }) => {
    await page.goto('/');
    await capture(page, 'projects-mobile');
  });
});
