/**
 * Response schemas — the API contract.
 *
 * These are the single source of truth for every shape this API returns.
 * Three things derive from them, which is the whole reason they exist:
 *
 *  1. **The OpenAPI document** (`lib/openapi.ts`), generated rather than
 *     hand-written. A hand-written spec is a second description of the system
 *     that drifts from the first, usually within a week.
 *  2. **Contract tests** (`tests/integration/contract.test.ts`), which validate
 *     real responses from a real database against these schemas. A spec nobody
 *     tests is documentation, not a contract.
 *  3. **UI types** — components import `z.infer<typeof ...>` from here, so a
 *     field the API stops returning is a compile error in the view rather than
 *     `undefined` on a screen.
 *
 * So: change a shape here, and the docs, the tests and the UI all move with
 * it, or fail loudly.
 */

import { z } from 'zod';

import { STATUS_CATEGORIES } from '@pmdash/db/queries';

/** ISO-8601. Dates cross the wire as strings; `z.date()` would be a lie. */
const isoDate = z.string().describe('ISO-8601 timestamp');
const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const errorSchema = z
  .object({
    error: z.object({
      code: z
        .enum([
          'VALIDATION_FAILED',
          'NOT_FOUND',
          'CONFLICT',
          'TAXONOMY_CONSTRAINT',
          'TERM_IN_USE',
          'SYSTEM_TAXONOMY',
          'UNPROCESSABLE',
          'INTERNAL',
        ])
        .describe('Stable. Branch on this, never on the message.'),
      message: z.string().describe('Written to be read by a person.'),
      correlationId: z
        .string()
        .describe('Quote this when reporting a problem; it finds the server log line.'),
      details: z.unknown().optional(),
    }),
  })
  .describe('Every failure has this shape.');

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const searchHitSchema = z.object({
  id: uuid,
  key: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  projectKey: z.string(),
  projectName: z.string(),
  status: z.string().nullable().describe("The term's label, in the preset's own vocabulary."),
  statusCategory: z.enum(STATUS_CATEGORIES).describe('Normalised. Branch on this, not on status.'),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  assignee: z.string().nullable(),
  isBlocked: z.boolean(),
  ageDays: z.number().nullable().describe('Days in flight. Null once completed.'),
  completedAt: isoDate.nullable(),
  rank: z.number().describe('Relevance when searching; recency otherwise.'),
});

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
  nextCursor: z
    .object({ rank: z.number(), id: uuid })
    .nullable()
    .describe('Pass back as cursorRank + cursorId. Keyset, so pages cannot shift.'),
  total: z.number().int().describe('Capped at 1000; see `truncated`.'),
  truncated: z.boolean(),
  facets: z
    .object({
      statusCategory: z.array(z.object({ value: z.string(), count: z.number().int() })),
      project: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const durationStatsSchema = z.object({
  n: z.number().int().describe('Below about 8 the percentiles are noise.'),
  medianDays: z.number().nullable(),
  p85Days: z.number().nullable().describe('85th percentile. Quote this when committing to a date.'),
});

export const forecastSchema = z
  .union([
    z.object({
      ok: z.literal(true),
      completionDate: z.string(),
      daysRemaining: z.number().int(),
      itemsPerDay: z.number(),
      r2: z.number(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.string().describe('Why no date can honestly be given.'),
    }),
  ])
  .describe('Refuses rather than guessing when the data cannot support a forecast.');

export const triggerSchema = z.object({
  rule: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  message: z.string().describe('A sentence a PM could say aloud, with the number that fired it.'),
  count: z.number().int(),
  evidence: z.object({ kind: z.enum(['items', 'impediments']), ids: z.array(uuid) }).optional(),
});

export const agingItemSchema = z.object({
  id: uuid,
  key: z.string(),
  title: z.string(),
  projectKey: z.string(),
  status: z.string().nullable(),
  statusCategory: z.enum(STATUS_CATEGORIES),
  assignee: z.string().nullable(),
  isBlocked: z.boolean(),
  ageDays: z.number(),
});

export const metricsResponseSchema = z.object({
  asOf: isoDate.describe('The instant everything here was computed as of.'),
  wip: z.object({
    inFlight: z.number().int(),
    blocked: z.number().int(),
    todo: z.number().int(),
    done: z.number().int(),
  }),
  cycle: durationStatsSchema.describe('completedAt - startedAt. Team working time.'),
  lead: durationStatsSchema.describe('completedAt - sourceCreatedAt. The requester’s wait.'),
  throughput: z.array(z.object({ weekStart: z.string(), completed: z.number().int() })),
  velocity: z.array(
    z.object({
      iterationId: uuid,
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      state: z.string(),
      committedPoints: z.number().nullable(),
      completedPoints: z.number(),
      completedCount: z.number().int(),
    }),
  ),
  flow: z.array(z.object({ day: z.string(), category: z.string(), count: z.number().int() })),
  aging: z.array(agingItemSchema),
  burnup: z.array(
    z.object({ day: z.string(), completed: z.number().int(), scope: z.number().int() }),
  ),
  forecast: forecastSchema,
  triggers: z.array(triggerSchema),
});

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const termSchema = z.object({
  id: uuid,
  taxonomyId: uuid,
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable().describe('A design-token name, not a hex value.'),
  sortOrder: z.number().int(),
  isDefault: z.boolean(),
  statusCategory: z
    .enum(STATUS_CATEGORIES)
    .nullable()
    .describe('Required on workflow_status terms; the bridge to every metric.'),
  archivedAt: isoDate.nullable().describe('Archived terms leave pickers but keep rendering.'),
  usageCount: z
    .number()
    .int()
    .describe('Rows referencing this term. Zero means it can be deleted.'),
});

export const taxonomySchema = z.object({
  id: uuid,
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean().describe('System taxonomies may be edited but not removed.'),
  drivesStatusCategory: z.boolean(),
  sortOrder: z.number().int(),
  terms: z.array(termSchema),
});

export const taxonomiesResponseSchema = z.object({ taxonomies: z.array(taxonomySchema) });
export const taxonomyResponseSchema = z.object({ taxonomy: taxonomySchema });
export const termResponseSchema = z.object({ term: termSchema });

export const usageResponseSchema = z.object({
  usage: z.object({
    total: z.number().int(),
    workItems: z.number().int(),
    projects: z.number().int(),
    impediments: z.number().int(),
    transitions: z.number().int(),
  }),
});

export const archivedResponseSchema = z.object({
  archived: z.literal(true),
  usageCount: z.number().int(),
});
export const deletedResponseSchema = z.object({ deleted: z.literal(true) });

/**
 * `DELETE /terms/{id}` archives by default and deletes with `?hard=true`, and
 * the two return different shapes.
 *
 * Declared as a union because that is the truth. The spec previously claimed
 * only the archive shape, and the contract tests caught the hard-delete
 * response violating it — which is precisely the drift a generated-and-tested
 * spec exists to prevent. A client generator now produces a union and the
 * caller has to handle both, which is correct.
 */
export const archivedOrDeletedSchema = z.union([archivedResponseSchema, deletedResponseSchema]);
export const restoredResponseSchema = z.object({ restored: z.literal(true) });
export const reorderedResponseSchema = z.object({ reordered: z.number().int() });

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export const savedViewSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: z.string(),
  config: z.object({
    description: z.string().optional(),
    filters: z.record(z.string(), z.unknown()),
    charts: z.array(z.string()).optional(),
    sort: z.enum(['rank', 'age', 'priority']).optional(),
  }),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const viewsResponseSchema = z.object({ views: z.array(savedViewSchema) });
export const viewResponseSchema = z.object({ view: savedViewSchema });

// ---------------------------------------------------------------------------
// Types the UI imports, so a view cannot disagree with the API
// ---------------------------------------------------------------------------

export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;
export type Term = z.infer<typeof termSchema>;
export type Taxonomy = z.infer<typeof taxonomySchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type ApiErrorBody = z.infer<typeof errorSchema>;
