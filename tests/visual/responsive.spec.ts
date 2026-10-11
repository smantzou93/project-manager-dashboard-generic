import { expect, test } from '@playwright/test';

import { capture, settle } from './_helpers';

test.describe('mobile', () => {
  test('does not scroll horizontally', async ({ page }) => {
    // The commonest responsive failure, and invisible in a desktop
    // screenshot: a wide table pushes the page sideways and every other
    // column goes off-screen.
    await page.goto('/dashboard');
    await settle(page);

    // Reports *which* element overflowed, not just that something did.
    // Written after a CI failure said "expected <= 1, received 35" and
    // nothing else — the page measured 0 locally and 0 in the Playwright
    // container, because text width depends on the font set and CI's fonts
    // are not any developer's. A number alone is not actionable.
    const { overflow, culprits } = await page.evaluate(() => {
      const root = document.documentElement;
      const vw = root.clientWidth;
      const seen = new Set<string>();
      const culprits: string[] = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const rect = el.getBoundingClientRect();
        if (rect.right <= vw + 1) continue;
        const key = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        culprits.push(`${key} right=${Math.round(rect.right)} w=${Math.round(rect.width)}`);
      }
      return { overflow: root.scrollWidth - vw, culprits: culprits.slice(0, 6) };
    });

    expect(
      overflow,
      culprits.length ?
        `viewport exceeded by these elements:\n  ${culprits.join('\n  ')}`
      : 'document is wider than the viewport, but no element exceeds it',
    ).toBeLessThanOrEqual(1);
  });

  test('visual', { tag: '@pixel' }, async ({ page }) => {
    await page.goto('/');
    await capture(page, 'projects-mobile');
  });
});
