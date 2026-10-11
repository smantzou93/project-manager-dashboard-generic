/**
 * The two things every view needs before it can render anything: when "now" is,
 * and what this installation calls its nouns.
 */

import { getLabels, type Labels } from '@pmdash/db/queries';

/**
 * Resolves the instant the dashboard is rendered "as of".
 *
 * Normally the wall clock. `PMDASH_AS_OF` overrides it, which exists for one
 * reason: the visual suite seeds a fixture at a pinned instant, and a dashboard
 * that computed `now()` itself would show that fixture aging by a day every day
 * — so every screenshot would differ from its baseline whether or not any code
 * changed.
 *
 * It is also genuinely useful outside tests: setting it answers "what did this
 * board look like at the end of last quarter" with no extra code.
 */
export function resolveAsOf(): Date {
  const pinned = process.env.PMDASH_AS_OF;
  if (!pinned) return new Date();
  const d = new Date(pinned);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`PMDASH_AS_OF is not a parseable date: ${pinned}`);
  }
  return d;
}

export type ViewContext = { asOf: Date; labels: Labels };

export async function getViewContext(): Promise<ViewContext> {
  return { asOf: resolveAsOf(), labels: await getLabels() };
}

/** Crude plural, adequate for the preset nouns actually in use. */
export const plural = (word: string) => (/s$/i.test(word) ? word : `${word}s`);

export const fmtDate = (d: string | Date | null) => {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(`${d}T00:00:00Z`) : d;
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

export const fmtDays = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}d`);
