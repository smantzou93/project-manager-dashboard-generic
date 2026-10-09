/**
 * Request schemas.
 *
 * Co-located so a route's contract is one file away from its handler, and
 * exported so the UI can reuse the same shapes rather than restating them.
 */

import { z } from 'zod';

import { STATUS_CATEGORIES } from '@pmdash/db/queries';

/**
 * A comma-separated query parameter, with every element validated.
 *
 * Splitting without validating is the trap: `?status=nonsense` arrives as
 * `["nonsense"]`, matches nothing, and returns 200 with an empty result. The
 * caller sees "no blocked work" and believes it, when in fact they made a
 * typo. A filter value that cannot possibly be right has to say so.
 *
 * It also keeps malformed ids out of the query layer entirely — an unvalidated
 * string reaching a `::uuid` cast is a 500, not a 400.
 */
const csvOf = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) =>
      Array.isArray(v) ? v
      : typeof v === 'string' ?
        v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : v,
    z.array(inner),
  );

const csvUuid = csvOf(z.string().uuid());

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  project: z.string().uuid().optional(),
  portfolio: z.string().uuid().optional(),
  status: csvOf(z.enum(STATUS_CATEGORIES)).optional(),
  type: csvUuid.optional(),
  priority: csvUuid.optional(),
  assignee: z.string().uuid().optional(),
  blocked: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Bounded on the server: a caller asking for 10,000 rows gets 100, rather
  // than a timeout plus a 500.
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursorRank: z.coerce.number().optional(),
  cursorId: z.string().uuid().optional(),
  facets: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * A slug is a machine name that ends up in URLs and config files, so it is
 * constrained rather than accepted as free text.
 */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, hyphen and underscore only');

export const createTermSchema = z.object({
  slug,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  color: z.string().trim().max(40).nullish(),
  statusCategory: z.enum(STATUS_CATEGORIES).nullish(),
});

export const updateTermSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullish(),
    color: z.string().trim().max(40).nullish(),
    statusCategory: z.enum(STATUS_CATEGORIES).nullish(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export const reorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

const savedViewConfigSchema = z.object({
  description: z.string().trim().max(300).optional(),
  filters: z.object({
    q: z.string().trim().max(200).optional(),
    projectId: z.string().uuid().optional(),
    portfolioId: z.string().uuid().optional(),
    statusCategory: z.array(z.enum(STATUS_CATEGORIES)).optional(),
    typeTermId: z.array(z.string().uuid()).optional(),
    priorityTermId: z.array(z.string().uuid()).optional(),
    assigneeId: z.string().uuid().optional(),
    isBlocked: z.boolean().optional(),
  }),
  charts: z.array(z.string().max(40)).max(12).optional(),
  sort: z.enum(['rank', 'age', 'priority']).optional(),
});

export const createViewSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.string().trim().max(40).optional(),
  config: savedViewConfigSchema,
});

export const updateViewSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: savedViewConfigSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export const metricsQuerySchema = z.object({
  project: z.string().uuid().optional(),
  portfolio: z.string().uuid().optional(),
  asOf: z.coerce.date().optional(),
});
