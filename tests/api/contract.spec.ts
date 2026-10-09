/**
 * Contract tests: the published OpenAPI document, checked against reality.
 *
 * These are driven **from the spec**, not from a hand-written list. The suite
 * fetches `/api/openapi.json`, enumerates every operation it declares, and
 * then calls each one against a real database and validates the response with
 * the spec's own JSON Schema.
 *
 * That direction matters. Validating responses against the zod schemas would
 * only prove zod agrees with zod. Validating against the *published document*
 * proves the thing a client generator consumes is honest — which is the only
 * version of this worth having.
 *
 * It also fails when an operation has no test, so an endpoint cannot be added
 * without its contract being exercised.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { expect, test, type APIRequestContext } from '@playwright/test';

type Json = Record<string, any>;

let spec: Json;
let ajv: Ajv;
/** Every operation the spec declares, as "METHOD /path". */
let declared: Set<string>;
/** Every operation a test actually exercised. */
const exercised = new Set<string>();

test.beforeAll(async ({ request }) => {
  const response = await request.get('/api/openapi.json');
  expect(response.ok(), 'the spec must be served').toBeTruthy();
  spec = (await response.json()) as Json;

  ajv = new Ajv({ strict: false, allErrors: true, discriminator: false });
  addFormats(ajv);
  // Register components so $ref resolves exactly as a client generator would.
  for (const [name, schema] of Object.entries(spec.components.schemas as Json)) {
    ajv.addSchema(schema as Json, `#/components/schemas/${name}`);
  }

  declared = new Set(
    Object.entries(spec.paths as Json).flatMap(([path, ops]) =>
      Object.keys(ops as Json).map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
});

/**
 * Validates a response body against what the spec says that operation returns.
 *
 * Records the operation as exercised, so the coverage test at the end can
 * fail on anything the suite forgot.
 */
function check(method: string, path: string, status: number, body: unknown): void {
  exercised.add(`${method} ${path}`);

  const operation = (spec.paths as Json)[path]?.[method.toLowerCase()] as Json | undefined;
  expect(operation, `${method} ${path} is not in the spec`).toBeDefined();

  const declaredSchema = operation!.responses?.[String(status)]?.content?.['application/json']
    ?.schema as Json | undefined;
  expect(
    declaredSchema,
    `${method} ${path} returned ${status}, which the spec does not document`,
  ).toBeDefined();

  const validate: ValidateFunction = ajv.compile(declaredSchema!);
  const valid = validate(body);
  if (!valid) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || '/'} ${e.message}`)
      .join('\n');
    throw new Error(
      `${method} ${path} → ${status} does not match its published schema:\n${errors}\n\n` +
        `Received: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
}

async function call(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  specPath: string,
  options?: { data?: unknown },
) {
  const response = await request[method](`/api${url}`, options as never);
  const body = (await response.json()) as unknown;
  check(method.toUpperCase(), specPath, response.status(), body);
  return { status: response.status(), body: body as Json, response };
}

// ---------------------------------------------------------------------------

test.describe('the spec itself', () => {
  test('is a well-formed OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info?.title).toBeTruthy();
    expect(Object.keys(spec.paths as Json).length).toBeGreaterThan(0);
  });

  test('declares an error shape for every operation that can fail', () => {
    for (const [path, ops] of Object.entries(spec.paths as Json)) {
      for (const [method, op] of Object.entries(ops as Json)) {
        const codes = Object.keys((op as Json).responses ?? {});
        expect(codes, `${method} ${path} declares no 200`).toContain('200');
        expect(
          codes.some((c) => c.startsWith('4') || c.startsWith('5')),
          `${method} ${path} declares no failure response`,
        ).toBeTruthy();
      }
    }
  });

  test('every $ref resolves', () => {
    const refs = JSON.stringify(spec).match(/"#\/components\/schemas\/(\w+)"/g) ?? [];
    for (const raw of new Set(refs)) {
      const name = raw.replace(/"/g, '').split('/').pop()!;
      expect(spec.components.schemas[name], `dangling $ref: ${name}`).toBeDefined();
    }
  });
});

test.describe('search', () => {
  test('GET /search matches its schema', async ({ request }) => {
    const { body } = await call(request, 'get', '/search?limit=5', '/search');
    expect(Array.isArray(body.hits)).toBe(true);
  });

  test('GET /search with facets and filters matches its schema', async ({ request }) => {
    const { body } = await call(
      request,
      'get',
      '/search?q=slab&status=blocked,in_review&facets=true&limit=3',
      '/search',
    );
    expect(body.facets).toBeDefined();
  });

  test('GET /search rejects an unknown status with the documented error shape', async ({
    request,
  }) => {
    const { status, body } = await call(request, 'get', '/search?status=nonsense', '/search');
    expect(status).toBe(400);
    // The point of validating this: a filter value that cannot be right must
    // say so, not quietly return zero results.
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.correlationId).toBeTruthy();
  });

  test('keyset pagination returns disjoint pages', async ({ request }) => {
    const first = await call(request, 'get', '/search?limit=5', '/search');
    const cursor = first.body.nextCursor as { rank: number; id: string } | null;
    expect(cursor).not.toBeNull();
    const second = await call(
      request,
      'get',
      `/search?limit=5&cursorRank=${cursor!.rank}&cursorId=${cursor!.id}`,
      '/search',
    );
    const ids = new Set((first.body.hits as Json[]).map((h) => h.id));
    for (const hit of second.body.hits as Json[]) expect(ids.has(hit.id)).toBe(false);
  });
});

test.describe('metrics', () => {
  test('GET /metrics matches its schema', async ({ request }) => {
    const { body } = await call(request, 'get', '/metrics', '/metrics');
    expect(body.wip.inFlight).toBeGreaterThan(0);
    expect(body.cycle.p85Days).toBeGreaterThan(body.cycle.medianDays);
  });

  test('GET /metrics rejects a malformed asOf', async ({ request }) => {
    const { status } = await call(request, 'get', '/metrics?asOf=not-a-date', '/metrics');
    expect(status).toBe(400);
  });
});

test.describe('taxonomies', () => {
  test('GET /taxonomies matches its schema', async ({ request }) => {
    const { body } = await call(request, 'get', '/taxonomies', '/taxonomies');
    expect((body.taxonomies as Json[]).length).toBeGreaterThan(0);
  });

  test('GET /taxonomies/{key} matches its schema', async ({ request }) => {
    const { body } = await call(request, 'get', '/taxonomies/workflow_status', '/taxonomies/{key}');
    expect(body.taxonomy.drivesStatusCategory).toBe(true);
  });

  test('DELETE /taxonomies/{key} refuses a system taxonomy', async ({ request }) => {
    const { status, body } = await call(
      request,
      'delete',
      '/taxonomies/workflow_status',
      '/taxonomies/{key}',
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('SYSTEM_TAXONOMY');
  });

  test('POST /taxonomies refuses a workflow status with no category', async ({ request }) => {
    // The guard that keeps the metrics computable.
    const { status, body } = await call(request, 'post', '/taxonomies', '/taxonomies', {
      data: { taxonomyKey: 'workflow_status', slug: 'limbo', label: 'Limbo' },
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('TAXONOMY_CONSTRAINT');
  });

  test('a term can be added, inspected, archived and restored', async ({ request }) => {
    const slug = `contract-test-${Date.now()}`;

    const created = await call(request, 'post', '/taxonomies', '/taxonomies', {
      data: { taxonomyKey: 'work_item_type', slug, label: 'Contract test' },
    });
    expect(created.status).toBe(200);
    const id = created.body.term.id as string;

    const usage = await call(request, 'get', `/terms/${id}`, '/terms/{id}');
    expect(usage.body.usage.total).toBe(0);

    const renamed = await call(request, 'patch', `/terms/${id}`, '/terms/{id}', {
      data: { label: 'Contract test renamed' },
    });
    expect(renamed.body.term.label).toBe('Contract test renamed');

    const archived = await call(request, 'delete', `/terms/${id}`, '/terms/{id}');
    expect(archived.body.archived).toBe(true);

    const restored = await call(request, 'post', `/terms/${id}`, '/terms/{id}');
    expect(restored.body.restored).toBe(true);

    // Unused, so a hard delete is allowed. Leaves the fixture as we found it.
    const deleted = await call(request, 'delete', `/terms/${id}?hard=true`, '/terms/{id}');
    expect(deleted.body.deleted).toBe(true);
  });

  test('PATCH /taxonomies/{key} reorders terms', async ({ request }) => {
    const current = await call(request, 'get', '/taxonomies/work_item_type', '/taxonomies/{key}');
    const ids = (current.body.taxonomy.terms as Json[]).map((t) => t.id as string);
    const { body } = await call(
      request,
      'patch',
      '/taxonomies/work_item_type',
      '/taxonomies/{key}',
      { data: { order: ids } },
    );
    expect(body.reordered).toBe(ids.length);
  });
});

test.describe('saved views', () => {
  test('a view can be created, read, updated and deleted', async ({ request }) => {
    const created = await call(request, 'post', '/views', '/views', {
      data: {
        name: `Contract test ${Date.now()}`,
        config: { filters: { statusCategory: ['blocked'] }, sort: 'age' },
      },
    });
    const id = created.body.view.id as string;

    await call(request, 'get', '/views', '/views');
    const fetched = await call(request, 'get', `/views/${id}`, '/views/{id}');
    expect(fetched.body.view.id).toBe(id);

    const updated = await call(request, 'patch', `/views/${id}`, '/views/{id}', {
      data: { name: 'Contract test renamed' },
    });
    expect(updated.body.view.name).toBe('Contract test renamed');

    const deleted = await call(request, 'delete', `/views/${id}`, '/views/{id}');
    expect(deleted.body.deleted).toBe(true);
  });

  test('GET /views/{id} 404s for an unknown id', async ({ request }) => {
    const { status, body } = await call(
      request,
      'get',
      '/views/00000000-0000-0000-0000-000000000000',
      '/views/{id}',
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------

test.describe('coverage', () => {
  test('every operation in the spec is exercised by a contract test', () => {
    // Runs last, so `exercised` is complete. This is what stops an endpoint
    // being added with a spec entry and no proof it behaves as documented.
    const missing = [...declared].filter((op) => !exercised.has(op)).sort();
    expect(missing, `operations declared but never tested:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
