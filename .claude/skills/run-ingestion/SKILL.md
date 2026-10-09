---
name: run-ingestion
description: Walk a CSV import through inspect, dry-run and confirmation. Proposes a column mapping, explains rejected rows in plain language, and only writes after the user explicitly agrees. Use when importing a CSV of work items, tasks, issues or a project schedule into the dashboard.
---

# Run a CSV import

The first thing anyone cloning this repo will try, and the one with
consequences that are tedious to undo.

## The rule that matters

**Never run `import` until the user has seen a dry run and said yes.**

`inspect` and `dry-run` write nothing — the dry run executes the identical
pipeline inside a transaction that is rolled back. Use them freely. `import`
writes to their database.

## 1. Inspect

```bash
npm run ingest -- inspect <file.csv>
```

Reports encoding, delimiter, where the header was found, row count, and the
proposed column mapping. Show the user this output.

Things worth flagging to them:

- **Warnings** about skipped preamble or renamed duplicate columns.
- **Unmapped columns** — kept verbatim in metadata, so nothing is lost, but
  they may want one mapped.
- **A wrong guess.** The mapper is good, not clairvoyant. "Trade" mapping to
  `type` may or may not be what they meant.
- **Missing date columns.** This is the highest-value thing to fix. Without
  created / started / completed, the import produces no history, and cycle
  time and the cumulative flow diagram will not include those rows. Say so
  before importing, not after.

Correct a mapping without editing anything:

```bash
npm run ingest -- inspect file.csv --map "Trade=type" --map "Notes=description" --map "Cost=ignore"
```

Other overrides when a guess is wrong: `--delimiter`, `--encoding`,
`--skip-rows`, `--id-column`.

## 2. Dry run

```bash
npm run ingest -- dry-run <file.csv> --project <KEY>
```

Show the user:

- counts by outcome — inserted, updated, unchanged, rejected
- the first rejects, with reasons
- **unknown taxonomy values** — a status or type matching no term. These are
  reported, never auto-created, because a typo'd status that quietly becomes a
  new term corrupts every flow metric. The user either adds the term
  deliberately or fixes the file.
- unmatched people — kept in metadata, not invented in the roster
- how many items will have no history

**Explain rejects in plain language.** `completed (2026-04-03) is before
created (2026-04-12)` means two cells are the wrong way round in that row.
Point at the row number — it matches their spreadsheet.

If the run exceeds the reject threshold it fails and says the mapping is
probably wrong. Usually it is. Re-map and dry-run again rather than raising
`--max-reject-ratio`.

## 3. Confirm, then import

Ask explicitly. Summarise what will change — _"this will insert 142 items into
RIVER and reject 3"_ — and wait for a clear yes.

```bash
npm run ingest -- import <file.csv> --project <KEY>
```

The mapping is saved to the data source, so the next upload from the same
place needs no mapping step.

## 4. Afterwards

```bash
source .env && docker exec -i pmdash-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select row_number, reason from ingestion_rejects order by id desc limit 20;"
```

Offer the rejects back so they can fix the source file and re-import — which
is safe, because the importer is idempotent. Re-running an unchanged file
reports everything as unchanged.

**If the pinned test fixture was the target**, tell them the integration suite
will now fail on changed row counts, and that
`./scripts/dev.sh --pinned --preset construction --seed-only` restores it.

## Reference

`docs/INGESTION.md` covers the mapping format, the reject ledger, idempotency,
how history is synthesised, and how to add a connector for a non-CSV source.
