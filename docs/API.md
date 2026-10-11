# API

A read-and-write HTTP API behind the same query layer the dashboard renders
from, so the numbers cannot disagree.

- **Swagger UI:** [`/api/docs`](http://localhost:3000/api/docs)
- **Spec:** [`/api/openapi.json`](http://localhost:3000/api/openapi.json) —
  OpenAPI 3.1

## The spec is generated, and tested

The OpenAPI document is generated from the zod schemas in
[`apps/web/lib/responses.ts`](../apps/web/lib/responses.ts) and
[`schemas.ts`](../apps/web/lib/schemas.ts). It is never hand-written: a
hand-written spec is a second description of the system, and the two drift —
usually within a week, always silently.

Those same schemas are the source for three things:

1. **The spec** at `/api/openapi.json`.
2. **Contract tests** (`npm run test:contract`) which fetch the published
   document, enumerate every operation it declares, call each against a real
   database, and validate the response with the spec's own JSON Schema.
   Validating against zod would only prove zod agrees with zod; validating
   against the _published document_ proves the thing a client generator
   consumes is honest.
3. **UI types** — views import `z.infer<>` from `responses.ts`, so a field the
   API stops returning is a compile error rather than `undefined` on screen.

The suite also fails when an operation has no test, so an endpoint cannot be
added without its behaviour being exercised.

This has already earned its keep. On the first run it caught the spec claiming
one response shape for `DELETE /terms/{id}` when the endpoint returns two, and
the seed writing saved views in a shape the API did not accept.

## Generating a client

```bash
npm run dev    # then, in another shell:
npx openapi-typescript http://localhost:3000/api/openapi.json -o client.d.ts
```

Any OpenAPI generator works. The document uses `components/schemas` with
`$ref`s, so you get one named type per concept rather than a pile of anonymous
duplicates.

## Errors

One shape, always:

```json
{
  "error": {
    "code": "TAXONOMY_CONSTRAINT",
    "message": "A workflow needs at least one \"done\" status...",
    "correlationId": "a1b2c3d4e5f6",
    "details": { "required": "done" }
  }
}
```

**Branch on `code`, never on `message`.** The codes are stable; the messages
are written to be read by people and will be reworded.

| Code                  | Status | Means                                         |
| --------------------- | ------ | --------------------------------------------- |
| `VALIDATION_FAILED`   | 400    | `details` names the offending fields          |
| `NOT_FOUND`           | 404    | No such resource                              |
| `CONFLICT`            | 409    | Duplicate slug, or similar                    |
| `TAXONOMY_CONSTRAINT` | 409    | The change would break the metrics            |
| `TERM_IN_USE`         | 409    | Rows reference it; `details` counts them      |
| `SYSTEM_TAXONOMY`     | 409    | Structural; its terms are editable, it is not |
| `INTERNAL`            | 500    | Ours. Quote the correlation id                |

Every response carries `x-correlation-id`. Quote it when reporting a problem —
it finds the server log line holding the stack. **Stacks never reach a
response**: this repository is public and the logs are not.

## Writing a client that works for any industry

The one thing to understand before using this API.

**Vocabulary is data here.** Statuses, types, priorities and severities are
rows the user can add, rename and archive — not fixed enumerations. A client
that hardcodes `"In Progress"` works for one installation and breaks on the
next.

**What is fixed is `statusCategory`**: `todo`, `in_progress`, `blocked`,
`in_review`, `done`, `cancelled`. Every workflow status maps onto one, and
every metric keys off it.

So:

```js
// Wrong — breaks on a construction install
if (item.status === 'In Review') { ... }

// Right — works everywhere
if (item.statusCategory === 'in_review') { ... }
```

Use `status` for display, `statusCategory` for logic. Fetch
`GET /api/taxonomies` for the labels the installation actually uses.

## Pagination

Keyset, not offset. `GET /api/search` returns `nextCursor`; pass it back as
`cursorRank` and `cursorId`.

Offsets shift under the reader: anything completed while they page through
moves every later row, so page two silently skips or repeats results. A keyset
cursor is stable.

## Worked examples

```bash
# Everything blocked, anywhere
curl '/api/search?status=blocked&limit=50'

# Free text plus facets, to show what narrowing would do
curl '/api/search?q=inspection&facets=true'

# The whole dashboard as JSON
curl '/api/metrics'

# What it looked like at the end of Q2
curl '/api/metrics?asOf=2026-06-30T23:59:59Z'

# Add a status, mapped onto a category so the charts keep working
curl -X POST '/api/taxonomies' -H 'content-type: application/json' -d '{
  "taxonomyKey": "workflow_status",
  "slug": "awaiting_client",
  "label": "Awaiting client",
  "statusCategory": "in_review"
}'

# Remove a category you do not want (archives; history keeps rendering)
curl -X DELETE '/api/terms/<id>'
```

## What the API will refuse, and why

These are not arbitrary. Each keeps something downstream true.

- **A workflow status with no `statusCategory`.** An item in it could never
  count as started or finished, so it would drop silently out of every metric.
- **Archiving the last `todo` or `done` status.** Without both ends of the
  funnel there is no cycle time and no velocity; every chart empties, and the
  cause is a settings change made an hour earlier.
- **Hard-deleting a term in use.** It would either fail on a foreign key or
  rewrite history. The refusal names the blocking rows so you can reassign
  them; archiving is almost always what was meant.
- **Deleting a system taxonomy.** The app has screens that read it. Its terms
  are entirely yours.

Changing a term's `statusCategory` also updates every work item denormalised
from it, so the two cannot disagree.

## Not here yet

Writing work items, authentication, and rate limiting. The dashboard is
read-only and runs on `127.0.0.1`; see the
[milestones](https://github.com/smantzou93/project-manager-dashboard-generic/milestones).
