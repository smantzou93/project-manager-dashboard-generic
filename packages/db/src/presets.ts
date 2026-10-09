/**
 * Domain presets: the starting vocabulary for an installation.
 *
 * A preset is a JSON file in packages/db/presets/. Applying one creates the
 * taxonomies and terms this installation uses, plus the nouns the UI shows
 * ("Sprint" vs "Phase", "points" vs "days"). Nothing about a preset is
 * permanent -- once applied, every term is editable from the settings UI, and
 * presets are only the seed.
 *
 * Adding a domain means dropping in a JSON file. No migration, no code change:
 *
 *   cp presets/generic.json presets/legal.json   # edit it
 *   npm run db:preset -- legal
 *
 * Applying a second preset is additive and idempotent: terms are matched on
 * (taxonomy key, slug), so re-running updates labels/colours/order in place and
 * never duplicates or silently drops a term that history references.
 */

import { readFile, readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import {
  SYSTEM_TAXONOMY_KEYS,
  appSettings,
  taxonomies,
  taxonomyTerms,
  type statusCategoryEnum,
} from './schema';

/**
 * The Drizzle handle these functions accept.
 *
 * Typed as the real client rather than `any`. The `any` version compiled, but
 * it erased every call in this file: `db.insert(...).values(...)` was unchecked
 * all the way down, so a wrong column name or a mistyped enum value would have
 * reached Postgres instead of failing at the keyboard. Taking the type from the
 * client keeps the seed and the preset CLI able to pass the same handle while
 * actually checking the queries.
 */
type Db = typeof import('./client').db;

type StatusCategory = (typeof statusCategoryEnum.enumValues)[number];

export type PresetTerm = {
  slug: string;
  label: string;
  description?: string;
  color?: string;
  icon?: string;
  isDefault?: boolean;
  /** Required for terms in the 'workflow_status' taxonomy; ignored elsewhere. */
  statusCategory?: StatusCategory;
};

export type PresetTaxonomy = {
  key: string;
  label: string;
  description?: string;
  /** Defaults to true for the keys in SYSTEM_TAXONOMY_KEYS. */
  isSystem?: boolean;
  terms: PresetTerm[];
};

export type Preset = {
  key: string;
  label: string;
  description?: string;
  /** Nouns this domain uses. Rendered by the UI instead of hardcoded strings. */
  labels: Record<string, string>;
  taxonomies: PresetTaxonomy[];
  /** Optional vocabulary the seed script uses to invent plausible demo rows. */
  demo?: {
    portfolios?: { key: string; name: string; description?: string }[];
    projects?: {
      key: string;
      name: string;
      portfolio: string;
      status: string;
      health: string;
      items: number;
    }[];
    milestones?: string[];
    epics?: string[];
    titleVerbs?: string[];
    titleNouns?: string[];
    impedimentTitles?: Record<string, string[]>;
    roles?: string[];
  };
};

const PRESET_DIR = new URL('../presets/', import.meta.url);

export async function listPresets(): Promise<string[]> {
  const files = await readdir(PRESET_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export async function loadPreset(name: string): Promise<Preset> {
  let raw: string;
  try {
    raw = await readFile(new URL(`${name}.json`, PRESET_DIR), 'utf8');
  } catch {
    const available = await listPresets();
    throw new Error(`Unknown preset "${name}". Available: ${available.join(', ')}`);
  }

  const preset = JSON.parse(raw) as Preset;
  validatePreset(preset, name);
  return preset;
}

/**
 * Fail loudly on a malformed preset rather than half-applying it. A preset that
 * forgets a statusCategory would otherwise produce a workflow whose items can
 * never count as done, which is a confusing thing to debug from the charts.
 */
export function validatePreset(preset: Preset, name: string): void {
  const problems: string[] = [];

  if (!preset.key) problems.push('missing "key"');
  if (!Array.isArray(preset.taxonomies)) problems.push('missing "taxonomies" array');

  const keys = new Set((preset.taxonomies ?? []).map((t) => t.key));
  for (const required of SYSTEM_TAXONOMY_KEYS) {
    if (!keys.has(required)) problems.push(`missing required taxonomy "${required}"`);
  }

  for (const tax of preset.taxonomies ?? []) {
    if (!tax.terms?.length) problems.push(`taxonomy "${tax.key}" has no terms`);

    const slugs = new Set<string>();
    for (const term of tax.terms ?? []) {
      if (!term.slug) problems.push(`taxonomy "${tax.key}" has a term with no slug`);
      if (slugs.has(term.slug)) problems.push(`taxonomy "${tax.key}" repeats slug "${term.slug}"`);
      slugs.add(term.slug);

      if (tax.key === 'workflow_status' && !term.statusCategory) {
        problems.push(
          `workflow_status term "${term.slug}" has no statusCategory -- ` +
            'every status must map onto a metrics bucket',
        );
      }
    }

    if (tax.key === 'workflow_status') {
      const cats = (tax.terms ?? []).map((t) => t.statusCategory);
      // Without both ends of the funnel there is no cycle time and no velocity.
      if (!cats.includes('todo')) problems.push('workflow_status has no "todo" status');
      if (!cats.includes('done')) problems.push('workflow_status has no "done" status');
    }
  }

  if (problems.length) {
    throw new Error(`Preset "${name}" is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Writes a preset into the database.
 *
 * Idempotent and additive. Existing terms are updated in place and existing
 * user-added terms are left untouched, so applying a preset over a live
 * installation refreshes the vocabulary without destroying data.
 */
export async function applyPreset(
  db: Db,
  preset: Preset,
  options: { setActive?: boolean } = {},
): Promise<{ taxonomies: number; terms: number }> {
  let taxCount = 0;
  let termCount = 0;

  for (const [index, tax] of preset.taxonomies.entries()) {
    const isSystem = tax.isSystem ?? (SYSTEM_TAXONOMY_KEYS as readonly string[]).includes(tax.key);

    const [taxRow] = await db
      .insert(taxonomies)
      .values({
        key: tax.key,
        label: tax.label,
        description: tax.description ?? null,
        isSystem,
        drivesStatusCategory: tax.key === 'workflow_status',
        sortOrder: index,
      })
      .onConflictDoUpdate({
        target: taxonomies.key,
        set: {
          label: tax.label,
          description: tax.description ?? null,
          sortOrder: index,
          updatedAt: new Date(),
        },
      })
      .returning();
    // An upsert that returns no row means neither the insert nor the update
    // took effect, so every term below would be orphaned with a null
    // taxonomy_id. Previously invisible: `db` was typed `any`, so this whole
    // block went unchecked.
    if (!taxRow) throw new Error(`failed to upsert taxonomy "${tax.key}"`);
    taxCount++;

    for (const [termIndex, term] of tax.terms.entries()) {
      await db
        .insert(taxonomyTerms)
        .values({
          taxonomyId: taxRow.id,
          slug: term.slug,
          label: term.label,
          description: term.description ?? null,
          color: term.color ?? null,
          icon: term.icon ?? null,
          sortOrder: termIndex,
          isDefault: term.isDefault ?? false,
          statusCategory: term.statusCategory ?? null,
        })
        .onConflictDoUpdate({
          target: [taxonomyTerms.taxonomyId, taxonomyTerms.slug],
          set: {
            label: term.label,
            description: term.description ?? null,
            color: term.color ?? null,
            icon: term.icon ?? null,
            sortOrder: termIndex,
            isDefault: term.isDefault ?? false,
            statusCategory: term.statusCategory ?? null,
            // Re-applying a preset un-archives a term it defines, which is the
            // natural way to restore one that was archived by mistake.
            archivedAt: null,
            updatedAt: new Date(),
          },
        });
      termCount++;
    }
  }

  if (options.setActive !== false) {
    await setSetting(db, 'active_preset', preset.key);
    await setSetting(db, 'labels', preset.labels ?? {});
  }

  return { taxonomies: taxCount, terms: termCount };
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (rows[0]?.value as T) ?? null;
}

/**
 * Resolves a taxonomy's terms into a slug -> id map, for bulk inserts that need
 * to turn human-readable slugs into foreign keys.
 */
export async function termMap(db: Db, taxonomyKey: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ slug: taxonomyTerms.slug, id: taxonomyTerms.id })
    .from(taxonomyTerms)
    .innerJoin(taxonomies, eq(taxonomies.id, taxonomyTerms.taxonomyId))
    .where(eq(taxonomies.key, taxonomyKey));
  return new Map(rows.map((r: { slug: string; id: string }) => [r.slug, r.id]));
}
