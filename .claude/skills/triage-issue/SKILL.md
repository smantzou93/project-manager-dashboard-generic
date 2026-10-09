---
name: triage-issue
description: Diagnose a failure in this dashboard from a correlation id, a symptom, or a GitHub issue number. Gathers logs across all four tiers, runs the integrity queries, checks the environment, and produces a written finding. Read-only — it proposes destructive commands rather than running them. Use when something is broken, a number looks wrong, a chart is blank, or an issue needs investigating.
---

# Triage an issue

Produce a diagnosis backed by evidence, not a guess.

## The rule that matters

**This skill reads. It does not fix.**

Never run `db-reset.sh`, drop a volume, delete rows, push, or modify the
working tree. The remedy for most problems here destroys the local database,
and that is the user's call. Propose the command; let them run it.

## 1. Check the known failures first

Read `docs/TRIAGE.md` before anything else. Its symptom-to-cause table covers
every failure this project has already hit, and recognising one instantly beats
re-debugging it. Common ones:

- Migrations succeed but the database is empty → the `drizzle` ledger schema
- Auth fails after regenerating `.env` → `POSTGRES_PASSWORD` is read at initdb
- Charts blank after an import → no `status_transitions` to derive from
- Two numbers disagree → one from `work_items`, one from history
- Lead time near zero → measured from `created_at` not `source_created_at`
- A metric changed with no code change → the pinned fixture drifted

If the symptom matches a row, say so, cite it, and verify rather than
investigating from scratch.

## 2. Gather evidence

**With a correlation id** — the whole operation, in order:

```bash
jq -s 'map(select(.correlation_id=="<id>")) | sort_by(.ts)' logs/*.log
```

**Without one:**

```bash
jq 'select(.level=="error")' logs/*.log | tail -40
jq -r 'select(.event=="slow_query") | "\(.duration_ms)ms \(.query)"' logs/db.log | sort -rn | head
```

**Environment:**

```bash
./scripts/preflight.sh --check          # tooling each tier can see
docker ps --filter name=pmdash-db       # is the database up
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A \
  -c "select key, value from app_settings where key in ('active_preset','seed_clock','seed_clock_pinned');"
```

The preset and seed clock matter more than they look: a number that seems
wrong is often correct for a differently-seeded fixture.

**Integrity** — run the full query from `docs/TRIAGE.md`. Every check should
return zero. A non-zero one usually _is_ the bug.

## 3. Reproduce if you can

Prefer a failing test or a query over a narrative. If you can turn the report
into something that fails, you have found it; if you cannot, say so rather
than asserting a cause.

## 4. Report

Write a finding with these parts, in this order:

1. **What failed** — one sentence, specific.
2. **Evidence** — the log lines, query output or test failure. Quote it.
3. **Cause** — and say how confident you are. "Consistent with" is honest
   when you have not reproduced it.
4. **Fix** — the command or the change. If destructive, mark it clearly and
   do not run it.
5. **Known?** — link the issue if `docs/TRIAGE.md` or GitHub already covers
   it. Do not open a duplicate.

Keep it short enough to read in a meeting.

## 5. Optionally file it

With the user's agreement:

```bash
gh issue create -t "<symptom, specifically>" -l "bug,area:<tier>" -m "<milestone>" -F -
```

Include the correlation id, the preset, and the integrity output. **Never
paste raw `.env` contents or unreviewed log lines** — secrets are redacted at
the serialiser, but a log line can still carry a project or person's name, and
this repository is public.

## When you find nothing

Say so plainly, list what you ruled out, and name what evidence would settle
it. An unsupported guess that sends someone down the wrong path is worse than
an honest dead end.
