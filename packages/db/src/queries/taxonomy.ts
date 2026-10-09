/**
 * Taxonomy reads and mutations.
 *
 * This is the module that makes the central promise of the project real: the
 * user can delete the categories they do not want and add their own. Every
 * guard below exists to let that be true without breaking the metrics.
 */

import { sql } from '../client';
import { SYSTEM_TAXONOMY_KEYS } from '../schema';

export type TermRow = {
  id: string;
  taxonomyId: string;
  slug: string;
  label: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  statusCategory: string | null;
  archivedAt: Date | null;
  /** How many rows point at this term. Drives whether delete is offered. */
  usageCount: number;
};

export type TaxonomyRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  drivesStatusCategory: boolean;
  sortOrder: number;
  terms: TermRow[];
};

export const STATUS_CATEGORIES = [
  'todo',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
] as const;

/** Thrown for a rule the API turns into a 409 with a readable message. */
export class TaxonomyRuleError extends Error {
  constructor(
    readonly rule: 'system_taxonomy' | 'term_in_use' | 'workflow_integrity' | 'duplicate_slug',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TaxonomyRuleError';
  }
}

const isSystemKey = (key: string) => (SYSTEM_TAXONOMY_KEYS as readonly string[]).includes(key);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every taxonomy with its terms.
 *
 * `usageCount` is computed here rather than on demand because the admin UI
 * needs it for every term at once — to know whether to offer delete or only
 * archive — and asking per term is N+1 on a settings screen.
 */
export async function listTaxonomies(includeArchived = false): Promise<TaxonomyRow[]> {
  const taxonomies = await sql<Omit<TaxonomyRow, 'terms'>[]>`
    select id, key, label, description, is_system as "isSystem",
           drives_status_category as "drivesStatusCategory", sort_order as "sortOrder"
    from taxonomies order by sort_order, key
  `;

  const terms = await sql<TermRow[]>`
    select tt.id, tt.taxonomy_id as "taxonomyId", tt.slug, tt.label, tt.description,
           tt.color, tt.sort_order as "sortOrder", tt.is_default as "isDefault",
           tt.status_category::text as "statusCategory", tt.archived_at as "archivedAt",
           (
             coalesce((select count(*) from work_items w
               where w.status_term_id = tt.id or w.type_term_id = tt.id
                  or w.priority_term_id = tt.id), 0)
           + coalesce((select count(*) from projects p
               where p.status_term_id = tt.id or p.health_term_id = tt.id), 0)
           + coalesce((select count(*) from impediments i
               where i.kind_term_id = tt.id or i.severity_term_id = tt.id), 0)
           )::int as "usageCount"
    from taxonomy_terms tt
    where ${includeArchived ? sql`true` : sql`tt.archived_at is null`}
    order by tt.sort_order, tt.label
  `;

  return taxonomies.map((t) => ({ ...t, terms: terms.filter((x) => x.taxonomyId === t.id) }));
}

export async function getTaxonomy(key: string): Promise<TaxonomyRow | null> {
  const all = await listTaxonomies(true);
  return all.find((t) => t.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuses a change that would leave the workflow unable to produce metrics.
 *
 * Checked *before* writing and against the state the write would produce, not
 * after. A workflow with no `todo` or no `done` has no cycle time and no
 * velocity — every chart silently empties, and the cause is a settings change
 * made an hour earlier.
 */
async function assertWorkflowStaysValid(
  taxonomyId: string,
  change: { termId?: string; nextCategory?: string | null; archiving?: boolean },
): Promise<void> {
  const [tax] = await sql<[{ key: string }]>`
    select key from taxonomies where id = ${taxonomyId}
  `;
  if (tax?.key !== 'workflow_status') return;

  const terms = await sql<{ id: string; status_category: string | null }[]>`
    select id, status_category::text from taxonomy_terms
    where taxonomy_id = ${taxonomyId} and archived_at is null
  `;

  const after = terms
    .filter((t) => !(change.archiving && t.id === change.termId))
    .map((t) =>
      t.id === change.termId && change.nextCategory !== undefined ?
        change.nextCategory
      : t.status_category,
    );

  for (const required of ['todo', 'done'] as const) {
    if (!after.includes(required)) {
      throw new TaxonomyRuleError(
        'workflow_integrity',
        `A workflow needs at least one "${required}" status. Without both ends of ` +
          'the funnel there is no cycle time and no velocity.',
        { required },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type CreateTerm = {
  taxonomyKey: string;
  slug: string;
  label: string;
  description?: string | null;
  color?: string | null;
  statusCategory?: string | null;
};

export async function createTerm(input: CreateTerm): Promise<TermRow> {
  const [tax] = await sql<[{ id: string; key: string }]>`
    select id, key from taxonomies where key = ${input.taxonomyKey}
  `;
  if (!tax) throw new TaxonomyRuleError('duplicate_slug', `No taxonomy "${input.taxonomyKey}".`);

  // A workflow status without a category can never count as started or
  // finished, so the item silently drops out of every metric. Refuse it.
  if (tax.key === 'workflow_status' && !input.statusCategory) {
    throw new TaxonomyRuleError(
      'workflow_integrity',
      'A workflow status needs a status category, so the metrics know what it means. ' +
        `One of: ${STATUS_CATEGORIES.join(', ')}.`,
      { allowed: STATUS_CATEGORIES },
    );
  }

  const [existing] = await sql<{ id: string; archived_at: Date | null }[]>`
    select id, archived_at from taxonomy_terms
    where taxonomy_id = ${tax.id} and slug = ${input.slug}
  `;
  if (existing && !existing.archived_at) {
    throw new TaxonomyRuleError(
      'duplicate_slug',
      `"${input.slug}" already exists in ${input.taxonomyKey}.`,
    );
  }

  const [row] = await sql<[TermRow]>`
    insert into taxonomy_terms
      (taxonomy_id, slug, label, description, color, status_category, sort_order)
    values (
      ${tax.id}, ${input.slug}, ${input.label}, ${input.description ?? null},
      ${input.color ?? null}, ${input.statusCategory ?? null},
      coalesce((select max(sort_order) + 1 from taxonomy_terms where taxonomy_id = ${tax.id}), 0)
    )
    on conflict (taxonomy_id, slug) do update set
      -- Re-creating an archived term restores it rather than failing. "Add the
      -- category back" is what the user means, and a term id that history
      -- already references is the right one to revive.
      label = excluded.label,
      description = excluded.description,
      color = excluded.color,
      status_category = excluded.status_category,
      archived_at = null,
      updated_at = now()
    returning id, taxonomy_id as "taxonomyId", slug, label, description, color,
              sort_order as "sortOrder", is_default as "isDefault",
              status_category::text as "statusCategory", archived_at as "archivedAt",
              0 as "usageCount"
  `;
  return row;
}

export type UpdateTerm = {
  label?: string;
  description?: string | null;
  color?: string | null;
  statusCategory?: string | null;
  sortOrder?: number;
};

export async function updateTerm(termId: string, input: UpdateTerm): Promise<TermRow> {
  const [current] = await sql<[{ taxonomy_id: string }]>`
    select taxonomy_id from taxonomy_terms where id = ${termId}
  `;
  if (!current) throw new TaxonomyRuleError('term_in_use', 'No such term.');

  if (input.statusCategory !== undefined) {
    await assertWorkflowStaysValid(current.taxonomy_id, {
      termId,
      nextCategory: input.statusCategory,
    });
  }

  const [row] = await sql<[TermRow]>`
    update taxonomy_terms set
      label = coalesce(${input.label ?? null}, label),
      description = ${input.description === undefined ? sql`description` : input.description},
      color = ${input.color === undefined ? sql`color` : input.color},
      status_category = ${
        input.statusCategory === undefined ?
          sql`status_category`
        : sql`${input.statusCategory}::status_category`
      },
      sort_order = coalesce(${input.sortOrder ?? null}, sort_order),
      updated_at = now()
    where id = ${termId}
    returning id, taxonomy_id as "taxonomyId", slug, label, description, color,
              sort_order as "sortOrder", is_default as "isDefault",
              status_category::text as "statusCategory", archived_at as "archivedAt",
              0 as "usageCount"
  `;

  // work_items denormalises the category for metric queries, so a change here
  // has to propagate or the two disagree -- exactly the class of bug that
  // makes a dashboard contradict itself.
  if (input.statusCategory) {
    await sql`
      update work_items set status_category = ${input.statusCategory}::status_category
      where status_term_id = ${termId}
    `;
  }

  return row;
}

/**
 * Archives a term: it leaves the pickers, history keeps rendering.
 *
 * This is what "remove this category" means here. A term in use is referenced
 * by thousands of historical rows; hard-deleting it would either fail on the
 * foreign key or rewrite what those rows say happened, and neither is what the
 * user is asking for.
 */
export async function archiveTerm(termId: string): Promise<{ archived: true; usageCount: number }> {
  const [current] = await sql<[{ taxonomy_id: string }]>`
    select taxonomy_id from taxonomy_terms where id = ${termId}
  `;
  if (!current) throw new TaxonomyRuleError('term_in_use', 'No such term.');

  await assertWorkflowStaysValid(current.taxonomy_id, { termId, archiving: true });

  await sql`update taxonomy_terms set archived_at = now(), updated_at = now() where id = ${termId}`;
  const usage = await termUsage(termId);
  return { archived: true, usageCount: usage.total };
}

export async function restoreTerm(termId: string): Promise<{ restored: true }> {
  await sql`update taxonomy_terms set archived_at = null, updated_at = now() where id = ${termId}`;
  return { restored: true };
}

export type Usage = {
  total: number;
  workItems: number;
  projects: number;
  impediments: number;
  transitions: number;
};

export async function termUsage(termId: string): Promise<Usage> {
  const [row] = await sql<[Usage]>`
    select
      (select count(*) from work_items
        where status_term_id = ${termId} or type_term_id = ${termId}
           or priority_term_id = ${termId})::int as "workItems",
      (select count(*) from projects
        where status_term_id = ${termId} or health_term_id = ${termId})::int as "projects",
      (select count(*) from impediments
        where kind_term_id = ${termId} or severity_term_id = ${termId})::int as "impediments",
      (select count(*) from status_transitions
        where from_term_id = ${termId} or to_term_id = ${termId})::int as "transitions"
  `;
  return { ...row, total: row.workItems + row.projects + row.impediments + row.transitions };
}

/**
 * Hard delete, allowed only when nothing references the term.
 *
 * Names the blocking rows rather than refusing flatly, so the user can decide
 * whether to reassign them or settle for archiving.
 */
export async function deleteTerm(termId: string): Promise<{ deleted: true }> {
  const usage = await termUsage(termId);
  if (usage.total > 0) {
    throw new TaxonomyRuleError(
      'term_in_use',
      `This term is used by ${usage.total} record(s), so deleting it would rewrite ` +
        'history. Archive it instead: it leaves the pickers and existing records keep rendering.',
      usage,
    );
  }

  const [current] = await sql<[{ taxonomy_id: string }]>`
    select taxonomy_id from taxonomy_terms where id = ${termId}
  `;
  if (current) await assertWorkflowStaysValid(current.taxonomy_id, { termId, archiving: true });

  await sql`delete from taxonomy_terms where id = ${termId}`;
  return { deleted: true };
}

/**
 * Deleting a whole taxonomy.
 *
 * System taxonomies are structural: the UI has dedicated screens reading them,
 * and removing the row leaves those screens with nothing. Their *terms* are
 * entirely the user's; the taxonomy itself is not.
 */
export async function deleteTaxonomy(key: string): Promise<{ deleted: true }> {
  if (isSystemKey(key)) {
    throw new TaxonomyRuleError(
      'system_taxonomy',
      `"${key}" is a system taxonomy and cannot be removed — the app has screens that ` +
        'read it. Its terms are yours to edit, archive or replace.',
      { key },
    );
  }
  await sql`delete from taxonomies where key = ${key}`;
  return { deleted: true };
}

export async function reorderTerms(taxonomyId: string, orderedIds: string[]): Promise<void> {
  // One statement rather than a loop: a partially applied reorder leaves the
  // list in an order nobody chose.
  await sql`
    update taxonomy_terms set sort_order = o.position, updated_at = now()
    from (select unnest(${orderedIds}::uuid[]) as id,
                 generate_subscripts(${orderedIds}::uuid[], 1) as position) o
    where taxonomy_terms.id = o.id and taxonomy_terms.taxonomy_id = ${taxonomyId}
  `;
}
