# Architecture

Four tiers. This document covers what each owns, what crosses each boundary,
and why the boundaries are where they are.

```
   browser
      │  HTML + inline SVG. No charting runtime, no client data fetching.
      ▼
┌─────────────────────────────────────────────────────┐
│  apps/web            Next.js, App Router            │
│                      Server components render the   │
│                      three views and act as the BFF │
└─────────────────────────────────────────────────────┘
      │  typed function calls — not HTTP
      ▼
┌─────────────────────────────────────────────────────┐
│  packages/db         Drizzle schema, the metric      │
│                      query layer, presets, seed      │
└─────────────────────────────────────────────────────┘
      │  SQL
      ▼
┌─────────────────────────────────────────────────────┐
│  Postgres 17         Dockerised, 127.0.0.1 only      │
└─────────────────────────────────────────────────────┘
      ▲
      │  psycopg
┌─────────────────────────────────────────────────────┐
│  apps/ingestion      Python CSV importer             │
└─────────────────────────────────────────────────────┘

  packages/logger  →  shared by web and db; the Python tier
                      emits the identical JSON schema
```

## Why these choices

### Next.js as its own BFF

The views are read-only and server-rendered. Server components call the query
layer as ordinary typed functions, so there is no HTTP hop, no DTO duplicated
either side of a wire, and no client-side data fetching at all.

A separate API service would buy independent scaling the dashboard does not
need, and cost a second copy of every type.

What this means in practice: **the three views contain no SQL.** Everything
comes from `packages/db/src/queries/`, so every number on every screen has one
definition. The alternative — a view computing "velocity" slightly differently
from the dashboard — is the failure mode this structure exists to prevent.

### Python for ingestion, not Node

CSV wrangling is where Python's libraries are genuinely better, and the
importer is a batch process with a different failure model from a web request:
it runs for minutes, partially succeeds, and needs a reject ledger rather than
a status code.

Keeping it a separate process means a 200k-row import cannot stall the
dashboard, and it can be run from cron or a queue without involving the web
tier at all.

The cost is a second language and a second test runner. The boundary is the
database — the importer writes the same tables the app reads, and the schema
is the contract. It does not call the web tier, and the web tier does not
import Python.

### Charts as inline SVG

No charting library. Three reasons, and the first is what decided it:

1. **Deterministic screenshots.** A library that animates on mount or derives
   tick counts from measured width renders differently on every run, which
   makes visual regression impossible before it starts.
2. No hydration cost on a read-only page.
3. They print, and these views end up in decks.

### Postgres only, no cache

The dashboard is read-heavy and aggregate-heavy, which is what Postgres is
good at. A cache would add a staleness window to numbers people use to decide
what to escalate — a stale metric is worse than a slow one. `force-dynamic` on
every page is deliberate.

If a query gets slow, the fix is an index or a `metric_snapshots` roll-up, not
a cache in front of a wrong answer.

## Boundaries

| Boundary             | Crosses it                                         | Does not                    |
| -------------------- | -------------------------------------------------- | --------------------------- |
| browser → web        | HTML, CSS, a little JS for nothing but hydration   | any data fetch              |
| web → db             | typed function calls, an explicit `asOf` and scope | raw SQL from a view         |
| db → Postgres        | parameterised SQL                                  | string-concatenated queries |
| ingestion → Postgres | psycopg, same schema                               | any call into the web tier  |
| every tier → logs    | the shared JSON schema, one correlation id         | secrets, stacks to a client |

## Request path

1. `middleware.ts` mints a correlation id (or adopts a sanitised inbound one)
   and sets it on request and response.
2. The page calls `withRequest()`, which opens an AsyncLocalStorage context so
   everything below is attributed without taking a parameter for it.
3. Server components call query functions with an explicit `asOf` and scope.
4. The query layer runs SQL; anything over 200ms logs with the correlation id.
5. The page renders SVG and HTML. Nothing fetches on the client.

One id reconstructs all of it — see `docs/TRIAGE.md`.

## Where state lives

| State              | Where                      | Why                                      |
| ------------------ | -------------------------- | ---------------------------------------- |
| Domain vocabulary  | `taxonomy_terms`           | Postgres enums cannot drop values        |
| UI nouns           | `app_settings.labels`      | so a preset re-labels the whole app      |
| Metric definitions | `packages/db/src/queries/` | one definition per number                |
| Trigger thresholds | `app_settings`             | a sprint and a construction phase differ |
| Import mappings    | `data_sources.config`      | the second upload needs no mapping       |
| Secrets            | the environment            | this repository is public                |

## What is not here yet

An HTTP API (M3), search and saved views (M3/M4), and the taxonomy admin UI
(M4). The query layer and the schema already support them; the views do not
exist. See the [milestones](https://github.com/smantzou93/project-manager-dashboard-generic/milestones).
