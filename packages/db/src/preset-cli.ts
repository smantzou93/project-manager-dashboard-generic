/**
 * Applies a domain preset to the current database.
 *
 *   npm run db:preset -- --list
 *   npm run db:preset -- construction
 *
 * Additive and idempotent: it never deletes a term, so running it against a
 * populated installation refreshes the vocabulary without touching history.
 */

import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { applyPreset, listPresets, loadPreset } from './presets';
import * as s from './schema';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const args = process.argv.slice(2);

if (args.includes('--list') || args.includes('-l')) {
  const names = await listPresets();
  console.log('Available presets:');
  for (const name of names) {
    const preset = await loadPreset(name);
    console.log(`  ${name.padEnd(18)} ${preset.description ?? preset.label}`);
  }
  process.exit(0);
}

const name = args.find((a) => !a.startsWith('-'));
if (!name) {
  console.error('Usage: npm run db:preset -- <name>   (or --list)');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run ./scripts/preflight.sh first.');
  process.exit(1);
}

const client = postgres(url, { max: 2 });
const db = drizzle(client, { schema: s });

try {
  const preset = await loadPreset(name);
  const result = await applyPreset(db, preset);
  console.log(
    `applied preset "${preset.key}": ${result.taxonomies} taxonomies, ${result.terms} terms`,
  );
  console.log(`labels: ${JSON.stringify(preset.labels)}`);
  await client.end();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await client.end({ timeout: 5 });
  process.exit(1);
}
