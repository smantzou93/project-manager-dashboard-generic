# Runbook

Start, stop, reset, re-seed, switch preset, rotate the password, back up — and
what to do when each goes wrong.

## First time on a machine

```bash
./scripts/preflight.sh
```

Inventories what you need (Node 20+, npm 10+, Python 3.11+, Docker 24+, git
2.30+), offers to install anything missing, detects your container runtime,
and generates `.env` with fresh random secrets.

Then:

```bash
./scripts/dev.sh
npm run hooks:install   # optional: enable the git hooks
```

## Everyday

|                   |                                          |
| ----------------- | ---------------------------------------- |
| Start everything  | `./scripts/dev.sh`                       |
| Start on a preset | `./scripts/dev.sh --preset construction` |
| Database only     | `./scripts/dev.sh --seed-only`           |
| Stop the database | `npm run db:down`                        |
| Stop the app      | Ctrl-C                                   |

`dev.sh` is safe to re-run. It starts your container runtime, waits for
Postgres to report healthy, applies migrations, seeds only if the database is
empty, and serves the app on :3000.

## Resetting

```bash
./scripts/db-reset.sh                            # rebuild schema, migrate, seed
./scripts/db-reset.sh --preset construction
./scripts/db-reset.sh --volume                   # also destroy the Docker volume
./scripts/db-reset.sh --no-seed                  # schema only
```

**`--volume` destroys all local data.** It is also the fix for the two most
common database problems, both below.

Why this is a script rather than a one-liner: Drizzle records applied
migrations in a separate `drizzle` schema, outside `public`. Dropping `public`
by hand deletes every table while leaving that ledger intact, after which
`db:migrate` reports success in milliseconds and creates nothing. The script
drops both and asserts a table count afterwards.

## Switching preset

```bash
npm run db:preset -- construction     # adds its vocabulary, keeps your data
./scripts/db-reset.sh --volume --preset construction   # genuinely start over
```

The first is additive — your own terms survive. The second wipes everything.

## Rotating the database password

Postgres reads `POSTGRES_PASSWORD` **only at `initdb`**. Changing it in `.env`
against an existing volume gives authentication failures that look like a
config problem.

```bash
# 1. back up first if the data matters
docker exec pmdash-db pg_dump -U pmdash pmdash > backup.sql

# 2. change POSTGRES_PASSWORD in .env, then rebuild the volume
./scripts/db-reset.sh --yes --volume --no-seed

# 3. restore
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backup.sql
```

## Backup and restore

```bash
source .env
docker exec pmdash-db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql
docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backup-2026-10-09.sql
```

A dump contains your project data and `data_sources.config`. It contains no
credentials — connectors reference environment variable names, not values —
but it is still not something to commit.

## Importing

```bash
npm run ingest -- inspect  file.csv                  # writes nothing
npm run ingest -- dry-run  file.csv --project RIVER  # writes nothing
npm run ingest -- import   file.csv --project RIVER
```

Full detail in `docs/INGESTION.md`.

## Tests

```bash
npm run lint && npm run typecheck && npm test   # ~5s
npm run test:integration                        # needs the pinned fixture
npm run test:visual                             # needs the app and a browser
npm run ingest:test                             # Python
npm run screenshots                             # refresh docs/screenshots/
npm run test:pixel                              # opt-in screenshot comparison (baselines are local)
```

The integration and visual suites need the fixture seeded at a pinned instant:

```bash
./scripts/dev.sh --pinned --preset construction --seed-only
```

## When something goes wrong

### Postgres will not start

```bash
docker compose logs db
docker ps --filter name=pmdash-db
```

If it reports `database files are incompatible`, the volume was created by a
different major version: `./scripts/db-reset.sh --volume`.

### `password authentication failed`

`.env` was regenerated after the volume was created. See rotating the password
above, or `./scripts/db-reset.sh --yes --volume` if the data is disposable.

### Migrations succeed but there are no tables

The `drizzle` ledger is out of sync with `public`.
`./scripts/db-reset.sh --yes --volume`.

### The app renders but every number is zero

The database is empty. `./scripts/dev.sh --preset construction`.

### Charts are blank after an import

The imported rows carry no dates, so there is no history to derive flow
metrics from. Expected — see `docs/INGESTION.md`.

### The integration suite fails with changed counts

Something wrote to the pinned fixture, usually an import.
`./scripts/dev.sh --pinned --preset construction --seed-only`.

### `npm run build` fails

Known upstream: Next 16.4 / React 19.3 fails prerendering `/_global-error`
(issue #39). `next dev` is unaffected.

### A command not found that is definitely installed

PATH differs between login, interactive and non-interactive shells.
`./scripts/preflight.sh --check` reports what each tier can actually see.

## Anything else

`docs/TRIAGE.md` has the symptom-to-cause table, the integrity queries and the
`jq` one-liners for reading the logs.
