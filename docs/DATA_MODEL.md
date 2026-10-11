# Data model

16 tables. The two decisions that shape all of them are at the top, because
everything else follows from them.

## 1. History is a separate, append-only table

`status_transitions` records every status change an item has ever made.

This exists because **a table holding only an item's current status cannot
answer "how long did this sit in review"** — and that is the question project
managers actually ask. Cycle time, lead time and the cumulative flow diagram
are all reconstructed from this table. Without it they are not approximations;
they are impossible.

Rules:

- Append only. Never update, never delete.
- Monotonic per item: timestamps never go backwards.
- The final transition's destination must equal the item's `status_term_id`.
- Every status change records one, including from an import.

That last rule has teeth. Blocked items once had no transition into the
blocked column, so the blocked-count tile read 30 while the cumulative flow
diagram showed none — two numbers on one dashboard contradicting each other,
which is how a dashboard stops being trusted.

Items also carry `started_at` and `completed_at` as real columns. That is
deliberate redundancy: a source supplying only summary data still yields
usable cycle and lead times without any history to reconstruct.

## 2. Vocabulary is data, not types

Item types, statuses, severities, priorities and health labels live in
`taxonomy_terms`. **They are not Postgres enums.**

Postgres can `ALTER TYPE ... ADD VALUE` but has no way to remove one. An app
that promises "delete the categories you don't want" cannot be built on them.
And "story" and "bug" are not universal nouns — "RFI", "submittal", "punch
item" and "site visit" are equally valid and must not require a migration.

What stays an enum is anything with _behaviour_ attached, where an unknown
value means a code path that does not exist:

| Enum              | Values                                                 |
| ----------------- | ------------------------------------------------------ |
| `status_category` | todo, in_progress, blocked, in_review, done, cancelled |
| `source_kind`     | csv, manual, github, jira, linear, asana               |
| `run_status`      | pending, running, succeeded, failed, partial           |
| `iteration_state` | future, active, closed                                 |
| `grain`           | day, week, month, sprint                               |

### `status_category` is the bridge

Every workflow status term points at one category. That single column is what
lets a construction PM create "Awaiting inspection", point it at `in_review`,
and have every flow chart keep working without knowing the word exists.

It is also denormalised onto `work_items.status_category`, so a metric query
does not join the taxonomy on every row.

**Branch on the category, never on the label.**

## The tables

### Vocabulary

| Table            | Holds                                                         |
| ---------------- | ------------------------------------------------------------- |
| `taxonomies`     | A dimension: `work_item_type`, `workflow_status`, `severity`… |
| `taxonomy_terms` | One selectable value. Archived, never deleted                 |
| `app_settings`   | Active preset, UI labels, trigger thresholds, seed provenance |

Eight system taxonomies ship with every preset: `work_item_type`,
`workflow_status`, `project_status`, `health`, `priority`, `severity`,
`impediment_kind`, `impediment_category`.

Terms are **archived** (`archived_at`), not deleted. A term in use is
referenced by thousands of historical rows; hard-deleting it would either fail
on the foreign key or rewrite history, and neither is what "remove this
category" should mean. Archived terms vanish from pickers while existing
records keep rendering.

### Work

| Table                | Holds                                                     |
| -------------------- | --------------------------------------------------------- |
| `portfolios`         | A grouping of projects. "Programme" in construction       |
| `projects`           | Key, status, health, owner, start / target / actual dates |
| `milestones`         | Named checkpoints with due dates                          |
| `iterations`         | Sprint / phase / cycle, with committed points and state   |
| `work_items`         | The central table — 30 columns                            |
| `status_transitions` | Append-only history                                       |
| `impediments`        | Blockers, with kind, severity, owner and open / resolved  |
| `people`             | The roster. Imports never create rows here                |

### Work item columns worth knowing

| Column                   | Note                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `source` + `external_id` | Unique together. The upsert key for every import            |
| `status_term_id`         | The term; `status_raw` keeps the source's own string        |
| `status_category`        | Denormalised from the term, for metric queries              |
| `source_created_at`      | When it came into existence **where the work lives**        |
| `created_at`             | Row bookkeeping — when _this database_ first saw it         |
| `is_blocked`             | Independent of column: tools mark blocked while In Progress |
| `labels`                 | `group` marks a parent container; excluded from aggregates  |
| `metadata`               | Unmapped import columns, verbatim. Nothing is lost          |
| `parent_id`              | Self-reference, `on delete set null`                        |

**`source_created_at` versus `created_at` matters more than it looks.** Lead
time measures from the former. For imported data they differ by months, so
measuring from `created_at` reports the import lag rather than the wait a
requester experienced. The schema comment named the wrong one once and it took
a failed integrity check to notice.

### Ingestion

| Table               | Holds                                                       |
| ------------------- | ----------------------------------------------------------- |
| `data_sources`      | Name, kind, and config — including the saved column mapping |
| `ingestion_runs`    | One row per run: status, counts, correlation id, stats      |
| `ingestion_rejects` | Rejected rows with their number, raw values and reason      |

`data_sources.config` holds connector settings only. **Never a credential** —
that column is backed up and this repository is public. Connectors name an
environment variable and resolve it at run time.

### Other

| Table              | Holds                                                |
| ------------------ | ---------------------------------------------------- |
| `saved_views`      | A named scope + filter set + chosen charts           |
| `metric_snapshots` | Pre-rolled metrics by grain. For scale, unused today |

## Group items

Parent containers carry `started_at = projectStart`, no `completed_at`, and
the label `group`. A container genuinely _is_ in flight for a project's
duration — but counted alongside leaf items it inflates WIP and dominates
aging.

So every aggregate excludes them: `not ('group' = any(wi.labels))`, via
`isLeaf()`. Identified by label rather than by type, because the type term's
slug differs per preset.

## Migrations

Drizzle owns the schema. Edit `packages/db/src/schema.ts`, then:

```bash
npm run db:generate && npm run db:migrate
```

**Drizzle records applied migrations in a separate `drizzle` schema, outside
`public`.** Dropping `public` by hand leaves that ledger intact, after which
`db:migrate` reports success in milliseconds and creates nothing — a database
that is empty while the tooling insists it is current. `db-reset.sh` drops
both, and asserts a table count afterwards so the failure cannot recur
silently.

The Python importer reads this structure but never migrates it.

## Integrity

`docs/TRIAGE.md` has eight checks that should all return zero. Run them
whenever a number looks wrong — a non-zero result usually _is_ the bug.
