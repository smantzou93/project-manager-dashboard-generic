import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Where the documentation screenshots land. Committed, referenced by the README
 * and the docs, refreshed only by `npm run screenshots`.
 */
const DOCS_DIR = path.join(process.cwd(), 'docs', 'screenshots');

/** True when this run should also write the documentation set. */
const WRITE_DOCS = process.env.PMDASH_WRITE_DOCS === '1';

/**
 * Waits until the page is genuinely static.
 *
 * `networkidle` alone is not enough. Web fonts swap in after first paint, which
 * reflows every label and shifts chart text by a pixel or two -- enough to fail
 * a diff on a page that has not actually changed. `document.fonts.ready` is the
 * signal that matters here.
 */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // Belt and braces: kill any transition the stylesheet declares, in case a
  // future change adds one that reducedMotion does not cover.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }`,
  });
}

/**
 * Compares against the committed baseline, and — only under
 * `npm run screenshots` — also writes the documentation copy.
 *
 * One capture serving both purposes keeps them honest: the image in the README
 * is the same image the regression suite is asserting against, so the docs
 * cannot quietly drift from what the app renders.
 */
export async function capture(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await settle(page);
  const fullPage = opts.fullPage ?? true;

  if (WRITE_DOCS) {
    await mkdir(DOCS_DIR, { recursive: true });
    const buf = await page.screenshot({ fullPage, animations: 'disabled', caret: 'hide' });
    await writeFile(path.join(DOCS_DIR, `${name}.png`), buf);
  }

  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage });
}

/** Text of a KPI tile, found by its label rather than its position. */
export async function tileValue(page: Page, label: string): Promise<string> {
  const tile = page.locator('.tile').filter({ has: page.getByText(label, { exact: true }) });
  await expect(tile).toHaveCount(1);
  // The <dd> holds the value plus an optional delta and sub-label; the first
  // text node is the number.
  return ((await tile.locator('dd').first().textContent()) ?? '').trim();
}
