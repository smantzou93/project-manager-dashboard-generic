# AGENTS.md

The single source of truth for anything — human or agent — working on this
repository. Vendor-specific files (`CLAUDE.md`, `.cursorrules`,
`.github/copilot-instructions.md`) point here and add nothing of substance, so
there is one document to keep current rather than five that drift.

---

## What this is

A project management dashboard meant to be cloned and re-pointed at any
industry. The organising claim: **nothing in it is specific to software.** The
same codebase serves a construction PM, an interior designer and an
engineering team, because the vocabulary lives in the database as editable
rows rather than in the code as fixed types.

If you change something that makes that less true, you have broken the point
of the project.

## Layout

```
apps/web            Next.js — three views and the BFF (React 19, App Router)
apps/ingestion      Python CSV importer (psycopg + pydantic)
packages/db         Drizzle schema, metric queries, presets, deterministic seed
packages/logger     Structured logging shared by the TypeScript tiers
scripts             preflight, dev, db-reset, screenshots
tests               unit (fast), integration (needs Postgres), visual (Playwright)
docs                the documents listed at the bottom of this file
```

## Running it

```bash
./scripts/preflight.sh     # first time on a machine: checks tooling, writes .env
./scripts/dev.sh           # everything: runtime, Postgres, migrations, seed, app
```

`dev.sh` brings the tiers up in order and checks each one, because each fails
for a different reason with a different fix.

Useful flags: `--preset construction`, `--pinned` (seed at the fixed test
instant), `--seed-only`, `--no-seed`.

---

## Invariants

These are the things an agent breaks. Each one has already caused a real bug
in this repository.

### 1. Domain vocabulary is data, never a Postgres enum

Item types, statuses, severities, priorities and health labels live in
`taxonomy_terms`. **Do not add a `pgEnum` for any of them.**

Postgres can add a value to an enum but can never remove one. An app that
promises "delete the categories you don't want" cannot be built on them.

Enums are reserved for things with _behaviour_ attached, where an unknown
value means a code path that does not exist: `status_category`, `source_kind`,
`run_status`, `grain`, `iteration_state`.

### 2. `status_category` is the bridge — every metric keys off it

Each workflow status term points at one of `todo`, `in_progress`, `blocked`,
`in_review`, `done`, `cancelled`. That single column is what lets a
construction PM create "Awaiting inspection", point it at `in_review`, and
have every flow chart keep working without knowing the word exists.

**Never branch on a status label.** Branch on the category.

### 3. `status_transitions` is append-only and must stay monotonic

Cycle time, lead time and the cumulative flow diagram are all derived from it,
because a table holding only the _current_ status cannot answer "how long did
this sit in review".

- Never update or delete a transition.
- An item's final transition destination must equal its `status_term_id`.
- Timestamps must never go backwards for an item.
- Any status change — including from an import — must record a transition.
  Blocked items once had none, so the blocked tile said 30 while the
  cumulative flow diagram showed zero. Two numbers on one dashboard that
  contradict each other is how a dashboard stops being trusted.

### 4. Metrics take an explicit `asOf`; queries never call `now()`

Metrics are time-relative. A query that reads the clock itself cannot be
tested — its answer changes daily — and cannot answer "what did this look like
at the end of Q2".

`PMDASH_SEED_NOW` pins the fixture's dates; `PMDASH_AS_OF` pins the app's
"now". Both are needed: pinning only the seed leaves the fixture ageing a day
every day.

### 5. Lead time measures from `source_created_at`, never `created_at`

`created_at` is row bookkeeping — when this database first saw the row. For
imported data the two differ by months, so lead time from `created_at` reports
the import lag rather than the wait a requester experienced.

### 6. Group items are excluded from every aggregate

Parent containers (epic / work package / phase, by preset) carry
`startedAt = projectStart`, no `completedAt`, and the label `group`. A
container genuinely is in flight for a project's duration, but counted
alongside leaf items it inflates WIP and dominates aging.

Filter with `not ('group' = any(wi.labels))` — there is a helper, `isLeaf()`.

### 7. The repository is public

- `.env` is generated locally, gitignored, never committed.
- Connector credentials are referenced by **environment variable name** and
  resolved at run time; `data_sources.config` is backed up and readable.
- Secrets are redacted at the log serialiser, not at call sites.
- Stack traces go to logs, never to a response.
- The pre-commit hook refuses a commit staging `.env` or a literal secret.

### 8. The UI never hardcodes a domain noun

Every visible label comes from the active preset via `getLabels()`. If you
type "Sprint", "story", "ticket" or "bug" into a component, you have broken
the genericity guarantee. There is a test asserting that `/dashboard` renders
zero occurrences of "Sprint".

---

## Where to look, by task

| Task                             | Read                                                    |
| -------------------------------- | ------------------------------------------------------- |
| Add or change a metric           | `packages/db/src/queries/metrics.ts`, `docs/METRICS.md` |
| Change the data model            | `packages/db/src/schema.ts`, `docs/DATA_MODEL.md`       |
| Add a domain / change vocabulary | `packages/db/presets/`, `docs/TAXONOMIES.md`            |
| Add a chart or a view            | `apps/web/components/charts.tsx`, `apps/web/app/`       |
| Import data                      | `apps/ingestion/`, `docs/INGESTION.md`                  |
| Something is broken              | `docs/TRIAGE.md` — start there, not with the code       |
| Add a test                       | `docs/TESTING.md`                                       |
| Run or reset anything            | `docs/RUNBOOK.md`                                       |

## Conventions

- **TypeScript** — strict, `noUncheckedIndexedAccess`. Prettier owns
  formatting; do not fight it. Relative imports inside workspace packages are
  **extensionless** (Turbopack does not apply TypeScript's `.js` → `.ts`
  substitution, and a `.js` specifier silently resolves to nothing).
- **Python** — ruff, 100 columns, type hints throughout.
- **SQL** — percentiles and date bucketing happen in SQL, not by pulling rows
  into Node. Pass dates through `ts()` from `queries/scope.ts`, never as bare
  `Date` objects (see below).
- **Comments** explain _why_. The code already says what.
- **Charts** are hand-written inline SVG. No charting library: one that
  animates on mount or derives tick counts from measured width renders
  differently on every run, which makes visual regression impossible.

## Verifying a change

```bash
npm run lint && npm run typecheck && npm test   # ~5s, what pre-commit runs
npm run test:integration                        # needs Postgres + pinned fixture
npm run test:visual                             # needs the app and a browser
npm run ingest:test                             # Python
```

A change to a metric definition should **break a test**. If it does not, the
metric was not covered and you should add the coverage with the change.

A change to a view will fail the visual suite. Review the diff, then
regenerate the baselines — **Linux is the authoritative set and CI compares
against it**, so do not just update the local one:

```bash
npm run baselines:linux      # via Docker; app and database stay on the host
```

Or comment `/baselines` on the pull request and let CI commit them.
`npm run test:visual:update` only refreshes your own platform's copy, which is
gitignored and which nothing compares against.

---

## Traps

Things that have cost real time here. Check these before debugging from
scratch.

**A type mismatch at a driver boundary.** This has happened three times and
every instance compiled cleanly while producing plausible wrong behaviour:

- `drizzle()` _mutates_ the postgres.js instance it is given, replacing the
  type serialisers. Raw `sql` on that connection then cannot bind a `Date` —
  hence `ts()`.
- `uuid.UUID` compared against `str` made every re-import look like a change.
- `Decimal` compared against `float` made "unchanged" unreachable.
- `sql.json()` is broken on that connection too. Use `json()` from
  `queries/scope.ts` with an explicit `::jsonb` cast, as with `ts()`.

The rule: **if you reach for a postgres.js value helper on this connection,
assume it is broken** and serialise explicitly.

**Drizzle's migration ledger lives in a separate `drizzle` schema.** Dropping
`public` alone leaves it intact, after which `db:migrate` reports success in
milliseconds and creates nothing. Use `./scripts/db-reset.sh --volume`.

**Postgres reads `POSTGRES_PASSWORD` only at `initdb`.** Regenerating `.env`
against an existing volume gives authentication failures that look like a
config bug. Same fix.

**Running an import against the pinned fixture breaks the integration suite,**
because the row counts change. Reseed with
`./scripts/dev.sh --pinned --preset construction --seed-only`.

**Nothing on the page is interactive, and there is no error.** Next 16 treats
`127.0.0.1` and `localhost` as different origins and blocks dev resources
between them, which stops the dev client bootstrapping and React mounting at
all. `allowedDevOrigins` in `apps/web/next.config.mjs` covers both; add any new
host there. The only clue is a warning on the server, not in the browser.

**Known upstream, not yours to fix:** `npm run build` fails prerendering
Next's internal `/_global-error`, and no 404 body renders. Both appear to be
one React 19.3 / Next 16.4 error-boundary defect (#39, #44). `next dev` is
unaffected.

---

## Documentation

|                                                |                                               |
| ---------------------------------------------- | --------------------------------------------- |
| [`README.md`](README.md)                       | What this is, and how to start it             |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The four tiers and what crosses each boundary |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)     | The 16 tables and why history is separate     |
| [`docs/TAXONOMIES.md`](docs/TAXONOMIES.md)     | Editing your own vocabulary                   |
| [`docs/METRICS.md`](docs/METRICS.md)           | The exact definition of every number          |
| [`docs/INGESTION.md`](docs/INGESTION.md)       | CSV import and the connector contract         |
| [`docs/PRESETS.md`](docs/PRESETS.md)           | Writing a preset for a new domain             |
| [`docs/TESTING.md`](docs/TESTING.md)           | The suites and the pinned clock               |
| [`docs/TRIAGE.md`](docs/TRIAGE.md)             | Symptom-to-cause, integrity queries           |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md)           | Start, stop, reset, rotate, back up           |

Work is tracked as [GitHub issues and
milestones](https://github.com/smantzou93/project-manager-dashboard-generic/issues).
Branch names: `feature/<issue-number>-<slug>`, off the milestone branch.
