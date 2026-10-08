/**
 * Single source of truth for the database shape.
 *
 * Drizzle owns the schema; the Python ingestion service reads this structure but
 * never migrates it (see docs/DATA_MODEL.md). Agents extending the model should
 * edit this file, then run `npm run db:generate && npm run db:migrate`.
 *
 * Two design rules make the flow metrics in docs/METRICS.md computable:
 *
 *  1. Every source status is kept verbatim in `work_items.status`, and is *also*
 *     mapped onto a fixed `status_category`. Raw statuses differ per tool
 *     ("In Review", "QA", "Code Review"); the category is what charts group by,
 *     so a new source can't break them.
 *
 *  2. Status changes are append-only rows in `status_transitions`. Cycle time,
 *     lead time and the cumulative flow diagram are all derived from that
 *     history. A table that only stores an item's *current* status can't answer
 *     "how long did this sit in review", which is the question PMs actually ask.
 */

import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/*
 * A deliberate note on why there are so few enums here.
 *
 * Domain vocabulary -- item types, severities, project statuses, health labels
 * -- lives in `taxonomy_terms` (below), NOT in Postgres enums. Two reasons:
 *
 *  1. Postgres can ADD a value to an enum but cannot REMOVE one. An app that
 *     promises "delete the categories you don't want" cannot be built on them.
 *
 *  2. This project is meant to be cloned by a construction PM, an interior
 *     designer or a marketer as readily as by a software team. "story" and
 *     "bug" are not universal nouns; "RFI", "submittal", "site visit" and
 *     "punch item" are equally valid and must not require a migration.
 *
 * What remains an enum is everything with behaviour attached, where an unknown
 * value would mean a code path that doesn't exist: status_category (the metrics
 * contract), source_kind (one connector implementation each), run_status and
 * grain. See docs/TAXONOMIES.md.
 */

/**
 * The normalised workflow bucket. Flow metrics key off this, never off the raw
 * status string.
 *
 * `blocked` is deliberately a category *and* a boolean flag on work_items:
 * the category is for "where is this item right now" (cumulative flow), the
 * flag is for "is it blocked" independent of which column it sits in, since
 * plenty of tools mark a blocked item while leaving it In Progress.
 */
export const statusCategoryEnum = pgEnum('status_category', [
  'todo',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
]);

/**
 * Lifecycle of an iteration. Stays an enum because it drives behaviour (which
 * iteration the dashboard treats as current) and is universal across domains --
 * a construction phase is equally future, active or closed. What an iteration is
 * *called* ("Sprint", "Phase", "Stage") is a label in app_settings.
 */
export const iterationStateEnum = pgEnum('iteration_state', ['future', 'active', 'closed']);

/**
 * Where a record came from. Only `csv` and `manual` are implemented today; the
 * rest are declared up front so adding a connector is a code change in the
 * ingestion service and not a migration. See docs/INGESTION.md.
 */
export const sourceKindEnum = pgEnum('source_kind', [
  'csv',
  'manual',
  'github',
  'jira',
  'linear',
  'asana',
]);

export const runStatusEnum = pgEnum('run_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'partial',
]);

/** Granularity of a rolled-up metric row. */
export const grainEnum = pgEnum('grain', ['day', 'week', 'month', 'sprint']);

// ---------------------------------------------------------------------------
// Taxonomies -- the user-editable vocabulary
// ---------------------------------------------------------------------------

/**
 * A dimension of vocabulary, e.g. "work_item_type" or "severity".
 *
 * Rows are seeded from a domain preset (packages/db/presets/*.json) and are then
 * the user's to rename, reorder, extend or archive from the settings UI. Adding
 * a whole new dimension is an INSERT here, not a migration, which is what lets
 * an agent extend the model for a domain nobody anticipated.
 */
export const taxonomies = pgTable(
  'taxonomies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable machine name the app and API reference, e.g. 'work_item_type'. */
    key: text('key').notNull(),
    /** What a human sees as the heading, e.g. "Work item types". */
    label: text('label').notNull(),
    description: text('description'),
    /**
     * System taxonomies are ones the UI has dedicated screens for, so they may
     * be edited but not deleted -- removing the row would leave those screens
     * with nothing to read. User-created taxonomies have no such constraint.
     */
    isSystem: boolean('is_system').notNull().default(false),
    /**
     * Set on the taxonomy whose terms map onto status_category. Exactly one
     * taxonomy plays that role ('workflow_status'); flagging it means the
     * metrics layer can find it without hardcoding the key.
     */
    drivesStatusCategory: boolean('drives_status_category').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('taxonomies_key_idx').on(t.key)],
);

/**
 * One selectable value within a taxonomy.
 *
 * Terms are archived rather than deleted (`archivedAt`). A term in use is
 * referenced by thousands of historical rows, and hard-deleting it would either
 * fail on the foreign key or rewrite history -- neither is what "remove this
 * category" should mean. Archived terms disappear from pickers while existing
 * records keep rendering correctly. docs/TAXONOMIES.md covers reassignment for
 * the case where a term really must go.
 */
export const taxonomyTerms = pgTable(
  'taxonomy_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxonomyId: uuid('taxonomy_id')
      .notNull()
      .references(() => taxonomies.id, { onDelete: 'cascade' }),
    /** Machine name, unique within the taxonomy. */
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /**
     * Presentation hints, so a new term looks deliberate without a code change.
     * `color` is a design-token name (not a hex value) so light and dark themes
     * both stay legible -- see docs/TAXONOMIES.md for the allowed set.
     */
    color: text('color'),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Value applied when a source or form supplies none. */
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Only meaningful for terms in the 'workflow_status' taxonomy: which
     * metrics bucket this status counts toward. This single column is the bridge
     * between free-form vocabulary and fixed metric maths -- a construction PM
     * can create an "Awaiting inspection" status and point it at `in_review`,
     * and every flow chart keeps working.
     */
    statusCategory: statusCategoryEnum('status_category'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('taxonomy_terms_slug_idx').on(t.taxonomyId, t.slug),
    index('taxonomy_terms_taxonomy_idx').on(t.taxonomyId, t.sortOrder),
    index('taxonomy_terms_active_idx').on(t.taxonomyId, t.archivedAt),
  ],
);

/**
 * Single-row-per-key settings: which preset is active, and the nouns this
 * installation uses ("Sprint" vs "Phase", "points" vs "hours" vs "$").
 * Keeping these as data is what makes one codebase readable to a software team
 * and a construction team without forking it.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: sourceKindEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    displayName: text('display_name').notNull(),
    email: text('email'),
    role: text('role'),
    avatarUrl: text('avatar_url'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial-free unique pair: lets the same human exist once per source, which
    // is what idempotent re-ingestion needs.
    uniqueIndex('people_source_external_idx').on(t.source, t.externalId),
    index('people_name_idx').on(t.displayName),
  ],
);

// ---------------------------------------------------------------------------
// Portfolio / project hierarchy
// ---------------------------------------------------------------------------

/** Top-level grouping that the multi-project view aggregates over. */
export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('portfolios_key_idx').on(t.key)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portfolioId: uuid('portfolio_id').references(() => portfolios.id, {
      onDelete: 'set null',
    }),
    /** Short human handle, e.g. "APOLLO". Used in URLs and search. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Term from the 'project_status' taxonomy. */
    statusTermId: uuid('status_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    /**
     * Term from the 'health' taxonomy -- the PM's judgement call (RAG status),
     * deliberately stored rather than derived, because it's an assessment that
     * can disagree with the raw numbers and often should.
     */
    healthTermId: uuid('health_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    ownerId: uuid('owner_id').references(() => people.id, { onDelete: 'set null' }),
    startDate: date('start_date'),
    targetDate: date('target_date'),
    actualEndDate: date('actual_end_date'),
    /** Free-form extras a given source carries that don't deserve a column. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    source: sourceKindEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_key_idx').on(t.key),
    uniqueIndex('projects_source_external_idx').on(t.source, t.externalId),
    index('projects_portfolio_idx').on(t.portfolioId),
    index('projects_status_idx').on(t.statusTermId),
    index('projects_health_idx').on(t.healthTermId),
  ],
);

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: sourceKindEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    name: text('name').notNull(),
    description: text('description'),
    dueDate: date('due_date'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('milestones_source_external_idx').on(t.source, t.externalId),
    index('milestones_project_idx').on(t.projectId),
    index('milestones_due_idx').on(t.dueDate),
  ],
);

/**
 * A bounded chunk of time that work is grouped into, and the unit velocity is
 * reported per.
 *
 * Called "iteration" rather than "sprint" on purpose: the same row models a
 * two-week agile sprint, a construction phase, a design milestone period or a
 * marketing campaign wave. The noun shown in the UI comes from the
 * `labels.iteration` app setting.
 */
export const iterations = pgTable(
  'iterations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: sourceKindEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    name: text('name').notNull(),
    goal: text('goal'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    state: iterationStateEnum('state').notNull().default('future'),
    /**
     * Snapshot of scope at iteration start. Stored rather than derived because
     * the committed set is only knowable at commit time -- recomputing it later
     * from current data silently hides mid-iteration scope changes, which is
     * exactly the signal the scope-creep metric needs.
     */
    committedPoints: numeric('committed_points', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('iterations_source_external_idx').on(t.source, t.externalId),
    index('iterations_project_idx').on(t.projectId),
    index('iterations_dates_idx').on(t.startDate, t.endDate),
  ],
);

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    iterationId: uuid('iteration_id').references(() => iterations.id, {
      onDelete: 'set null',
    }),
    milestoneId: uuid('milestone_id').references(() => milestones.id, {
      onDelete: 'set null',
    }),
    /**
     * Self-reference builds the epic -> story -> subtask tree. Typed through
     * AnyPgColumn because the table is still being defined at this point.
     * `set null` on delete so removing an epic orphans its children rather than
     * silently cascading away a pile of real work.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => workItems.id, {
      onDelete: 'set null',
    }),

    source: sourceKindEnum('source').notNull().default('manual'),
    /** Stable id in the originating system; the upsert key for re-ingestion. */
    externalId: text('external_id'),
    /** Display key such as "APOLLO-142". */
    key: text('key'),

    /** Term from the 'work_item_type' taxonomy (story, bug, RFI, site visit...). */
    typeTermId: uuid('type_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description'),

    /** Term from the 'workflow_status' taxonomy -- this installation's columns. */
    statusTermId: uuid('status_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    /** Verbatim source status. Kept so re-ingestion can map unknown values and
     *  so the original wording survives even if a term is later renamed. */
    statusRaw: text('status_raw'),
    /**
     * Denormalised copy of the status term's category.
     *
     * Redundant with taxonomy_terms.status_category by design: every flow metric
     * filters or groups on it, and joining through the taxonomy on each of those
     * queries would cost a lookup per row for a value that changes only when the
     * term mapping changes. Kept in sync on write -- see docs/TAXONOMIES.md.
     */
    statusCategory: statusCategoryEnum('status_category').notNull().default('todo'),

    /** Term from the 'priority' taxonomy. Ordering comes from the term's sortOrder. */
    priorityTermId: uuid('priority_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    /** Story points. numeric, since plenty of teams use 0.5 and 1.5. */
    estimate: numeric('estimate', { precision: 10, scale: 2 }),
    timeSpentHours: numeric('time_spent_hours', { precision: 10, scale: 2 }),

    assigneeId: uuid('assignee_id').references(() => people.id, { onDelete: 'set null' }),
    reporterId: uuid('reporter_id').references(() => people.id, { onDelete: 'set null' }),

    /**
     * Timestamps that define the flow metrics:
     *   lead time  = completedAt - sourceCreatedAt  (customer-visible wait)
     *   cycle time = completedAt - startedAt        (team working time)
     * Kept as real columns rather than derived from transitions so that sources
     * which supply only summary data still yield usable metrics.
     *
     * Lead time measures from `sourceCreatedAt` -- when the item came into
     * existence where the work actually lives -- and NEVER from `createdAt`
     * below, which is row bookkeeping and equals the moment this database first
     * saw the row. For a CSV import those differ by months, so computing lead
     * time from `createdAt` would report "imported 5 minutes ago" as the wait a
     * customer experienced.
     */
    sourceCreatedAt: timestamp('source_created_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    dueDate: date('due_date'),

    labels: text('labels').array().notNull().default([]),

    /** Blocked-ness independent of workflow column; see statusCategoryEnum. */
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),

    /** Provenance: which run last touched this row. */
    ingestionRunId: uuid('ingestion_run_id'),
    /** Row bookkeeping, not domain history. For metrics use sourceCreatedAt. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_items_source_external_idx').on(t.source, t.externalId),
    index('work_items_project_idx').on(t.projectId),
    index('work_items_iteration_idx').on(t.iterationId),
    index('work_items_type_idx').on(t.typeTermId),
    index('work_items_status_term_idx').on(t.statusTermId),
    index('work_items_milestone_idx').on(t.milestoneId),
    index('work_items_parent_idx').on(t.parentId),
    index('work_items_category_idx').on(t.statusCategory),
    index('work_items_assignee_idx').on(t.assigneeId),
    // Throughput and velocity scan by completion date within a project.
    index('work_items_completed_idx').on(t.projectId, t.completedAt),
    // Aging WIP needs "started but not finished", ordered by age.
    index('work_items_started_idx').on(t.projectId, t.startedAt),
    index('work_items_blocked_idx').on(t.isBlocked),
  ],
);

/**
 * Append-only workflow history. One row per status change.
 *
 * `durationInFromSeconds` is denormalised on write because the alternative --
 * a window function over the whole table on every dashboard load -- is the
 * query that gets slow first as history accumulates.
 */
export const statusTransitions = pgTable(
  'status_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    /**
     * Terms from the 'workflow_status' taxonomy. Carried alongside the raw
     * strings because the cumulative flow diagram draws one band per real
     * column in the user's own order -- which needs the term's sortOrder, not
     * just the six fixed categories.
     */
    fromTermId: uuid('from_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    toTermId: uuid('to_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    /** Raw strings as the source reported them; survive term renames. */
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    fromCategory: statusCategoryEnum('from_category'),
    toCategory: statusCategoryEnum('to_category').notNull(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    durationInFromSeconds: integer('duration_in_from_seconds'),
    actorId: uuid('actor_id').references(() => people.id, { onDelete: 'set null' }),

    ingestionRunId: uuid('ingestion_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transitions_item_time_idx').on(t.workItemId, t.occurredAt),
    // The cumulative flow diagram reads every transition in a project by date.
    index('transitions_project_time_idx').on(t.projectId, t.occurredAt),
    index('transitions_to_category_idx').on(t.toCategory),
    // Re-ingesting the same changelog must not duplicate history.
    uniqueIndex('transitions_dedupe_idx').on(t.workItemId, t.toStatus, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// "What's holding us back"
// ---------------------------------------------------------------------------

/**
 * Blockers, risks and cross-team dependencies -- the things a PM reports
 * upward. Separate from `work_items.isBlocked` because an impediment often
 * outlives any single ticket and frequently has no ticket at all.
 */
export const impediments = pgTable(
  'impediments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, {
      onDelete: 'set null',
    }),
    /** Term from the 'impediment_kind' taxonomy (blocker, risk, dependency...). */
    kindTermId: uuid('kind_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    /** Term from the 'severity' taxonomy. Ranking comes from the term's sortOrder. */
    severityTermId: uuid('severity_term_id').references(() => taxonomyTerms.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description'),
    /**
     * Free text on purpose. Grouping impediments by cause is how the "what's
     * holding us back" panel finds themes, and the useful buckets differ per
     * organisation -- an enum here would force a migration per new cause.
     * Conventional values are listed in docs/METRICS.md.
     */
    category: text('category'),
    ownerId: uuid('owner_id').references(() => people.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    source: sourceKindEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('impediments_source_external_idx').on(t.source, t.externalId),
    index('impediments_project_idx').on(t.projectId),
    // The dashboard's default question is "what's open, worst first".
    index('impediments_open_idx').on(t.projectId, t.resolvedAt, t.severityTermId),
    index('impediments_category_idx').on(t.category),
    index('impediments_kind_idx').on(t.kindTermId),
  ],
);

// ---------------------------------------------------------------------------
// Ingestion bookkeeping
// ---------------------------------------------------------------------------

export const dataSources = pgTable(
  'data_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    /**
     * Connector settings only -- column mappings, URLs, project filters.
     * Never credentials: those are referenced by env var name and resolved at
     * run time, because this database is backed up and this repo is public.
     */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('data_sources_name_idx').on(t.name)],
);

/** One row per ingestion attempt. The ledger agents read when a load misbehaves. */
export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dataSourceId: uuid('data_source_id').references(() => dataSources.id, {
      onDelete: 'set null',
    }),
    /**
     * Shared with the structured logs in ./logs, so a run in this table can be
     * grepped straight out of the log files. See docs/TRIAGE.md.
     */
    correlationId: text('correlation_id').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    status: runStatusEnum('status').notNull().default('pending'),
    /** True when the run parsed and validated but intentionally wrote nothing. */
    dryRun: boolean('dry_run').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    rowsRead: integer('rows_read').notNull().default(0),
    rowsUpserted: integer('rows_upserted').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    error: text('error'),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    sourceFile: text('source_file'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_source_idx').on(t.dataSourceId),
    index('runs_started_idx').on(t.startedAt),
    uniqueIndex('runs_correlation_idx').on(t.correlationId),
  ],
);

/**
 * Rows that failed validation, kept with their reason.
 *
 * A rejected row is a question for a human ("is this column mapped right?"), so
 * discarding it with only a count would make a partly-bad CSV undebuggable.
 */
export const ingestionRejects = pgTable(
  'ingestion_rejects',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ingestionRunId: uuid('ingestion_run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number'),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rejects_run_idx').on(t.ingestionRunId)],
);

// ---------------------------------------------------------------------------
// Derived metrics and saved views
// ---------------------------------------------------------------------------

/**
 * Rolled-up metric values.
 *
 * The dashboard computes live from `work_items` and `status_transitions` for
 * correctness; this table exists so expensive historical series (and any
 * as-of-then value whose inputs have since been edited) stay cheap and stable.
 * A null projectId means the row is portfolio-wide.
 */
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id').references(() => portfolios.id, {
      onDelete: 'cascade',
    }),
    /** Stable identifier from docs/METRICS.md, e.g. "velocity.points". */
    metricKey: text('metric_key').notNull(),
    grain: grainEnum('grain').notNull().default('week'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    value: numeric('value', { precision: 16, scale: 4 }),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('metric_snapshots_unique_idx').on(t.projectId, t.metricKey, t.grain, t.periodStart),
    index('metric_snapshots_lookup_idx').on(t.metricKey, t.periodStart),
  ],
);

/** Persisted filter sets backing the consolidated views and presentation decks. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** 'project' | 'portfolio' | 'dashboard' */
    kind: text('kind').notNull().default('dashboard'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('saved_views_name_kind_idx').on(t.name, t.kind)],
);

// ---------------------------------------------------------------------------
// Inferred types -- import these instead of redeclaring shapes.
// ---------------------------------------------------------------------------

export type Taxonomy = typeof taxonomies.$inferSelect;
export type TaxonomyTerm = typeof taxonomyTerms.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Portfolio = typeof portfolios.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Iteration = typeof iterations.$inferSelect;
export type WorkItem = typeof workItems.$inferSelect;
export type StatusTransition = typeof statusTransitions.$inferSelect;
export type Impediment = typeof impediments.$inferSelect;
export type DataSource = typeof dataSources.$inferSelect;
export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type MetricSnapshot = typeof metricSnapshots.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;

export type NewProject = typeof projects.$inferInsert;
export type NewWorkItem = typeof workItems.$inferInsert;
export type NewStatusTransition = typeof statusTransitions.$inferInsert;
export type NewImpediment = typeof impediments.$inferInsert;
export type NewTaxonomy = typeof taxonomies.$inferInsert;
export type NewTaxonomyTerm = typeof taxonomyTerms.$inferInsert;

/**
 * Taxonomy keys the UI has dedicated screens for. Presets must define terms for
 * all of these; anything beyond them is a user-created dimension.
 */
export const SYSTEM_TAXONOMY_KEYS = [
  'work_item_type',
  'workflow_status',
  'project_status',
  'health',
  'priority',
  'severity',
  'impediment_kind',
  'impediment_category',
] as const;

export type SystemTaxonomyKey = (typeof SYSTEM_TAXONOMY_KEYS)[number];
