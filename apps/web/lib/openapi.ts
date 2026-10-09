/**
 * The OpenAPI 3.1 document, generated from the zod schemas.
 *
 * Generated, never hand-written. A hand-written spec is a second description
 * of the system, and the two drift — usually within a week, always silently.
 * Here the request schemas in `schemas.ts` and the response schemas in
 * `responses.ts` are the only source, so the document cannot describe
 * something the code does not do.
 *
 * OpenAPI 3.1 is a superset of JSON Schema 2020-12, which is exactly what
 * `z.toJSONSchema()` emits, so no conversion layer and no extra dependency.
 */

import { z } from 'zod';

import * as req from './schemas';
import * as res from './responses';

/**
 * Collected named schemas. Emitted once under `components/schemas` and
 * referenced, so the document stays readable and a client generator produces
 * one type per concept rather than twelve anonymous duplicates.
 */
const COMPONENTS = {
  Error: res.errorSchema,
  SearchHit: res.searchHitSchema,
  SearchResponse: res.searchResponseSchema,
  MetricsResponse: res.metricsResponseSchema,
  Forecast: res.forecastSchema,
  Trigger: res.triggerSchema,
  AgingItem: res.agingItemSchema,
  Term: res.termSchema,
  Taxonomy: res.taxonomySchema,
  SavedView: res.savedViewSchema,
  Usage: res.usageResponseSchema,
} as const;

type Json = Record<string, unknown>;

function schema(s: z.ZodType, io: 'input' | 'output' = 'output'): Json {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Json;
  // $schema belongs on a standalone document, not on an inlined subschema.
  delete out.$schema;
  return out;
}

const ref = (name: keyof typeof COMPONENTS) => ({ $ref: `#/components/schemas/${name}` });

/** Turns a zod object into OpenAPI query parameters. */
function queryParams(s: z.ZodType): Json[] {
  const json = schema(s, 'input');
  const props = (json.properties ?? {}) as Record<string, Json>;
  const required = (json.required ?? []) as string[];
  return Object.entries(props).map(([name, def]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: def,
    ...(def.description ? { description: def.description } : {}),
  }));
}

const jsonBody = (s: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: schema(s, 'input') } },
});

const ok = (s: z.ZodType | Json, description = 'Success') => ({
  description,
  content: { 'application/json': { schema: '$ref' in (s as Json) ? s : schema(s as z.ZodType) } },
});

const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description: errorDescription(c),
        content: { 'application/json': { schema: ref('Error') } },
      },
    ]),
  );

function errorDescription(code: number): string {
  switch (code) {
    case 400:
      return 'The request did not validate. `details` names the offending fields.';
    case 404:
      return 'No such resource.';
    case 409:
      return 'A rule refused the change. The message explains which, and why.';
    default:
      return 'Something went wrong. Quote `correlationId` when reporting it.';
  }
}

const idParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

export function openApiDocument(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Project manager dashboard API',
      version: '0.1.0',
      description:
        'Read and edit the dashboard behind the UI.\n\n' +
        '**Vocabulary is data here.** Statuses, types, priorities and severities are rows ' +
        'you can add, rename and archive — not fixed enumerations. What *is* fixed is ' +
        '`statusCategory`: every workflow status maps onto one of six categories, and that ' +
        'is what every metric keys off. Branch on the category, never on the label, and your ' +
        'client works for a construction firm and a software team alike.\n\n' +
        '**Errors** all share one shape with a stable `code`. Branch on the code, not the ' +
        'message. Every response carries `x-correlation-id`; quote it when reporting a problem.',
      license: { name: 'MIT' },
    },
    servers: [{ url: '/api', description: 'Same origin as the app' }],
    tags: [
      { name: 'search', description: 'Cross-project search over work items' },
      { name: 'metrics', description: 'The numbers the dashboard renders' },
      { name: 'taxonomies', description: 'The editable vocabulary' },
      { name: 'views', description: 'Saved consolidated slices' },
    ],

    paths: {
      '/search': {
        get: {
          tags: ['search'],
          summary: 'Search work items across every project',
          description:
            'Cross-project by default. Pagination is keyset, not offset: pass `cursorRank` ' +
            'and `cursorId` from `nextCursor`. An offset would let rows shift under a reader ' +
            'as work completes, silently skipping or repeating results.',
          parameters: queryParams(req.searchQuerySchema),
          responses: { 200: ok(ref('SearchResponse')), ...errors(400, 500) },
        },
      },

      '/metrics': {
        get: {
          tags: ['metrics'],
          summary: 'Everything the dashboard renders, as JSON',
          description:
            'The same snapshot the dashboard shows — not a second implementation, so the ' +
            'numbers cannot disagree. `asOf` answers "what did this look like at the end of ' +
            'Q2" with no extra work.\n\nDefinitions are in docs/METRICS.md. Two worth knowing ' +
            'before using these: cycle time is reported as a median and 85th percentile and ' +
            'never a mean, because the distribution is long-tailed; and `forecast` refuses ' +
            'rather than guessing when the data cannot support a date.',
          parameters: queryParams(req.metricsQuerySchema),
          responses: { 200: ok(ref('MetricsResponse')), ...errors(400, 500) },
        },
      },

      '/taxonomies': {
        get: {
          tags: ['taxonomies'],
          summary: 'Every taxonomy with its terms',
          parameters: [
            {
              name: 'archived',
              in: 'query',
              schema: { type: 'string', enum: ['true', 'false'] },
              description: 'Include archived terms.',
            },
          ],
          responses: { 200: ok(res.taxonomiesResponseSchema), ...errors(500) },
        },
        post: {
          tags: ['taxonomies'],
          summary: 'Add a term',
          description:
            'A `workflow_status` term **must** carry a `statusCategory`, and the request is ' +
            'refused without one: a status that maps to no category can never count as ' +
            'started or finished, so items in it drop silently out of every metric.\n\n' +
            'Re-adding an archived slug restores that term rather than failing — history ' +
            'already references its id, and reviving it is what "add the category back" means.',
          requestBody: jsonBody(req.createTermSchema.extend({ taxonomyKey: z.string() })),
          responses: { 200: ok(res.termResponseSchema), ...errors(400, 409, 500) },
        },
      },

      '/taxonomies/{key}': {
        get: {
          tags: ['taxonomies'],
          summary: 'One taxonomy, including archived terms',
          parameters: [idParam('key', 'Taxonomy key, e.g. `workflow_status`.')],
          responses: { 200: ok(res.taxonomyResponseSchema), ...errors(404, 500) },
        },
        patch: {
          tags: ['taxonomies'],
          summary: 'Reorder terms',
          description: 'Applied in one statement, so a partial reorder cannot happen.',
          parameters: [idParam('key', 'Taxonomy key.')],
          requestBody: jsonBody(req.reorderSchema),
          responses: { 200: ok(res.reorderedResponseSchema), ...errors(400, 404, 500) },
        },
        delete: {
          tags: ['taxonomies'],
          summary: 'Delete a user-created taxonomy',
          description:
            'System taxonomies are refused with `SYSTEM_TAXONOMY`. The app has screens that ' +
            'read them, and removing the row leaves those screens with nothing. Their terms ' +
            'are entirely yours to change.',
          parameters: [idParam('key', 'Taxonomy key.')],
          responses: { 200: ok(res.deletedResponseSchema), ...errors(409, 500) },
        },
      },

      '/terms/{id}': {
        get: {
          tags: ['taxonomies'],
          summary: 'What references this term',
          description: 'Use this to decide whether to offer delete or only archive.',
          parameters: [idParam('id', 'Term id.')],
          responses: { 200: ok(ref('Usage')), ...errors(500) },
        },
        patch: {
          tags: ['taxonomies'],
          summary: 'Rename, recolour or recategorise a term',
          description:
            'Changing a `statusCategory` also updates every work item denormalised from it, ' +
            'so the two cannot disagree. A change that would leave the workflow without a ' +
            '`todo` or a `done` is refused: without both ends of the funnel there is no ' +
            'cycle time and no velocity.',
          parameters: [idParam('id', 'Term id.')],
          requestBody: jsonBody(req.updateTermSchema),
          responses: { 200: ok(res.termResponseSchema), ...errors(400, 409, 500) },
        },
        delete: {
          tags: ['taxonomies'],
          summary: 'Archive a term, or delete it outright',
          description:
            'Archives by default, which is almost always what "remove this category" means: ' +
            'the term leaves the pickers while existing records keep rendering.\n\n' +
            '`?hard=true` deletes, and is refused with `TERM_IN_USE` when anything references ' +
            'the term — the refusal names the blocking rows so you can reassign them.',
          parameters: [
            idParam('id', 'Term id.'),
            {
              name: 'hard',
              in: 'query',
              schema: { type: 'string', enum: ['true', 'false'] },
              description: 'Delete rather than archive. Only possible when usage is zero.',
            },
          ],
          responses: {
            200: ok(
              res.archivedOrDeletedSchema,
              'Archived (`{archived, usageCount}`), or deleted when `hard=true` (`{deleted}`).',
            ),
            ...errors(409, 500),
          },
        },
        post: {
          tags: ['taxonomies'],
          summary: 'Restore an archived term',
          parameters: [idParam('id', 'Term id.')],
          responses: { 200: ok(res.restoredResponseSchema), ...errors(500) },
        },
      },

      '/views': {
        get: {
          tags: ['views'],
          summary: 'List saved views',
          parameters: [{ name: 'kind', in: 'query', schema: { type: 'string' } }],
          responses: { 200: ok(res.viewsResponseSchema), ...errors(500) },
        },
        post: {
          tags: ['views'],
          summary: 'Save a view',
          description:
            'Filters are stored as structured JSON and validated on write, not as an opaque ' +
            'query string — so an agent can read a saved view, see what it selects, and ' +
            'change it.',
          requestBody: jsonBody(req.createViewSchema),
          responses: { 200: ok(res.viewResponseSchema), ...errors(400, 500) },
        },
      },

      '/views/{id}': {
        get: {
          tags: ['views'],
          summary: 'One saved view',
          parameters: [idParam('id', 'View id.')],
          responses: { 200: ok(res.viewResponseSchema), ...errors(404, 500) },
        },
        patch: {
          tags: ['views'],
          summary: 'Update a saved view',
          parameters: [idParam('id', 'View id.')],
          requestBody: jsonBody(req.updateViewSchema),
          responses: { 200: ok(res.viewResponseSchema), ...errors(400, 404, 500) },
        },
        delete: {
          tags: ['views'],
          summary: 'Delete a saved view',
          parameters: [idParam('id', 'View id.')],
          responses: { 200: ok(res.deletedResponseSchema), ...errors(404, 500) },
        },
      },
    },

    components: {
      schemas: Object.fromEntries(Object.entries(COMPONENTS).map(([name, s]) => [name, schema(s)])),
    },
  };
}
