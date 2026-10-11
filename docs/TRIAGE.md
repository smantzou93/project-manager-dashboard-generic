# Triage

What to read, and in what order, when something is broken. Written for someone
— or something — with no prior context on this repository.

## Start here

```bash
jq 'select(.correlation_id=="<id>")' logs/*.log | jq -s 'sort_by(.ts)'
```

Every response carries its correlation id in the `x-correlation-id` header, and
every log line across all four tiers carries the same field. One id
reconstructs a whole operation: the page render, every query it ran, and the
ingestion run it triggered.

**Getting an id from a report:**

| The user has       | Where the id is                                      |
| ------------------ | ---------------------------------------------------- |
| A browser error    | Network tab → the failing request → response headers |
| A 500 page         | Printed on the page as "Reference"                   |
| A failed import    | The run summary, and `ingestion_runs.correlation_id` |
| Nothing but a time | `jq 'select(.ts > "2026-10-08T14:00")' logs/*.log`   |

## Symptom to cause

Every row here cost real time at least once. Check this table before
debugging from scratch.

### Database

**Migrations report success but the database is empty.**
Drizzle records applied migrations in a separate `drizzle` schema, outside
`public`. Dropping `public` by hand deletes every table while leaving that
ledger intact, after which `db:migrate` reports "migrations applied" in
milliseconds and creates nothing.
→ `./scripts/db-reset.sh --yes --volume` (drops both schemas). Issue #7.

**`password authentication failed` right after regenerating `.env`.**
Postgres only reads `POSTGRES_PASSWORD` at `initdb`. An existing volume still
expects the old one, no matter what `.env` now says.
→ `./scripts/db-reset.sh --yes --volume`. Issue #10.

**`.env: line N: command not found`.**
A generated secret contained shell metacharacters. Secrets are now restricted
to `[A-Za-z0-9]` for exactly this reason.
→ Regenerate with `./scripts/preflight.sh`. Issue #8.

### Charts and numbers

**Charts are blank after a CSV import.**
Cycle time, lead time and the cumulative flow diagram are all derived from
`status_transitions`. An import of a file carrying only _current_ status has no
history to reconstruct, so those items appear nowhere.
→ Expected, not a bug. Map the date columns and re-import. The run summary
says how many items this affected. See docs/INGESTION.md.

**Two numbers on the dashboard disagree.**
Almost always one is read from `work_items` and the other derived from
`status_transitions`. They must agree; when they do not, history is missing or
duplicated.
→ Run the integrity queries below. This exact class of bug shipped once:
blocked items had no transition into the blocked column, so the blocked tile
said 30 and the cumulative flow diagram showed none.

**Lead time is near zero, or equals "time since import".**
Something is measuring from `created_at` instead of `source_created_at`.
`created_at` is row bookkeeping — when this database first saw the row. For
imported data the two differ by months.
→ Every metric must use `source_created_at`. The schema comment named the
wrong one once; see `packages/db/src/queries/metrics.ts`.

**A metric looks wrong but no code changed.**
Check whether the fixture drifted. Running an import against the pinned test
fixture adds rows, and the integration suite will fail with changed counts.
→ `./scripts/dev.sh --pinned --preset construction --seed-only`.

### Application

**A page renders but nothing is interactive. No error anywhere.**
Buttons do nothing, inputs do not update, effects never run, and a screen sits
on its loading state forever. The browser console is clean.

Next 16 blocks cross-origin requests to dev resources, and treats `127.0.0.1`
and `localhost` as _different origins_. If the app is served on one and opened
on the other, `/_next/hmr` is blocked, the dev client never bootstraps, and
React never mounts a renderer. The only sign is a warning on the **server**:

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1"
```

→ `allowedDevOrigins` in `apps/web/next.config.mjs` already lists both. If you
add another host, add it there. Confirm with the probe:
`npx playwright test --grep hydrates`.

Diagnosing from the browser: `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size`
is `0` and no element has a `__react*` property. That means React never
mounted — which is a very different problem from a component that rendered
wrong, and worth checking first.

**Pages 500 with `DATABASE_URL is not set`.**
Next reads `.env` relative to `apps/web`; the real file is at the repository
root. `apps/web/load-root-env.mjs` loads it, so this means that file was
bypassed or the app was started in an unusual way.
→ Use `./scripts/dev.sh`. Note that this failure only appears in a clean
shell — a shell that already exported the variables masks it.

**`npm run build` fails on `/_global-error`.**
A React 19.3 / Next 16.4 defect in the error-boundary render path, not in this
code. `next dev` is unaffected.
→ Known, issue #39. Related: no 404 body renders either (#44).

**`command not found` for a tool that is definitely installed.**
PATH differs between login, interactive and non-interactive shells. A tool on
the PATH in a terminal is not necessarily on it in a script or a hook.
→ `./scripts/preflight.sh --check` reports what each tier can actually see.

**A re-import reports everything as "updated" when nothing changed.**
A type mismatch at the driver boundary: `uuid.UUID` compared against `str`,
or `Decimal` against `float`. These compile and produce plausible wrong
behaviour rather than an error.
→ This pattern has appeared three times. Check the comparison types first.

## Integrity queries

Run these whenever a number looks wrong. Every one should return zero.

```sql
select 'completed before started' as check, count(*) from work_items
  where completed_at is not null and started_at is not null and completed_at < started_at
union all select 'started before created', count(*) from work_items
  where started_at is not null and started_at < source_created_at
union all select 'out-of-order transitions', count(*) from (
    select lag(occurred_at) over (partition by work_item_id order by id) prev, occurred_at
    from status_transitions) t where prev > occurred_at
union all select 'broken transition chain', count(*) from (
    select from_term_id, lag(to_term_id) over (partition by work_item_id order by id) prev_to
    from status_transitions) t where prev_to is not null and from_term_id is distinct from prev_to
union all select 'transition before item created', count(*) from status_transitions st
  join work_items wi on wi.id = st.work_item_id where st.occurred_at < wi.source_created_at
union all select 'blocked item without a blocked transition', count(*) from work_items wi
  where wi.status_category = 'blocked' and not exists (
    select 1 from status_transitions st
    where st.work_item_id = wi.id and st.to_category = 'blocked')
union all select 'final transition disagrees with item', count(*) from work_items wi
  join (select distinct on (work_item_id) work_item_id, to_term_id from status_transitions
        order by work_item_id, id desc) l on l.work_item_id = wi.id
  where wi.status_term_id is distinct from l.to_term_id
union all select 'status_category disagrees with term', count(*) from work_items wi
  join taxonomy_terms tt on tt.id = wi.status_term_id
  where wi.status_category is distinct from tt.status_category;
```

Run it:

```bash
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f - < query.sql
```

## Useful one-liners

```bash
# Slowest queries, worst first
jq -r 'select(.event=="slow_query") | "\(.duration_ms)ms \(.query)"' logs/db.log | sort -rn | head

# Every error today
jq 'select(.level=="error")' logs/*.log

# One request's full trace, in order
jq -s 'map(select(.correlation_id=="<id>")) | sort_by(.ts)' logs/*.log

# Which pages are slow
jq -r 'select(.event=="page_rendered") | "\(.duration_ms)ms \(.route)"' logs/web.log | sort -rn | head

# What the last import did
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select status, rows_read, rows_upserted, rows_rejected, stats from ingestion_runs order by started_at desc limit 1;"

# Why rows were rejected
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select row_number, reason from ingestion_rejects order by id desc limit 20;"
```

Log levels: `LOG_LEVEL=debug` for everything, `PMD_SLOW_QUERY_MS=0` to log
every query rather than only slow ones. Both are useful for a single
reproduction and overwhelming left on.

## Reproducing from clean

If none of the above fits, rule out local state:

```bash
./scripts/preflight.sh                                    # check the tooling
./scripts/db-reset.sh --yes --volume --preset construction # rebuild the database
./scripts/dev.sh                                           # start everything
```

If the problem survives that, it is in the code.

## Filing a useful issue

Include:

1. **The correlation id**, and the log lines it pulls.
2. **The preset** — `select value from app_settings where key = 'active_preset'`.
3. **Integrity query output**, if a number looks wrong.
4. **Whether a clean rebuild reproduces it.**

Leave out: anything from `.env`, and raw log lines you have not read. Secrets
are redacted at the serialiser, but a log line can still contain a project
name or a person's name, and this repository is public.
