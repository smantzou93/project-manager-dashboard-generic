# Ingestion

Importing work items from a CSV, and the contract a future connector
implements.

## In the browser

Open **Import** in the nav, drop a CSV, and the page walks the same three
steps the CLI does — inspect, dry run, then an explicit confirm. Nothing is
written until the last one, and it tells you what it is about to do:

> Import 142 rows into RIVER — _this writes to the database._

Uploads are capped at 25MB, must be `.csv`, are written to a private temp
directory (never inside the repository, never served, never executed), and are
passed to the importer as an argument rather than through a shell.

The web tier does not reimplement any of the import logic. It runs the same
CLI with `--json` and relays the result, because two implementations of "what
does this CSV mean" would drift and the one people trusted would be whichever
they read last.

## On the command line

```bash
# What is in this file, and how would it be mapped? Writes nothing.
npm run ingest -- inspect ~/Downloads/site-works.csv

# Full pipeline inside a transaction that is rolled back. Writes nothing.
npm run ingest -- dry-run ~/Downloads/site-works.csv --project RIVER

# Commit it.
npm run ingest -- import ~/Downloads/site-works.csv --project RIVER
```

Dry run first, always. It is the default for the library API for the same
reason: writing to someone's database is tedious to undo.

## What it copes with

Real exports are not tidy, and none of that is the user's fault. The importer
sniffs rather than assumes, and every guess can be overridden.

| Situation                      | Behaviour                                                                   |
| ------------------------------ | --------------------------------------------------------------------------- |
| Excel BOM                      | Detected (`utf-8-sig`) so it does not end up inside the first column's name |
| Semicolons, tabs, pipes        | Delimiter chosen by consistency across the body                             |
| Jira preamble above the header | Scanned for and skipped, with a warning                                     |
| latin-1 / cp1252               | Tried in order; always decodes to _something_ readable                      |
| Duplicate column names         | Renamed (`Name`, `Name_1`), never silently overwritten                      |
| Quoted commas and newlines     | Handled by the `csv` module                                                 |
| Cells past the header width    | Kept as `_extra_N` rather than dropped                                      |
| `N/A`, `-`, `TBC`, blank       | Treated as empty, not as literal text                                       |

**Delimiter detection does not use `csv.Sniffer`.** Sniffer reads from the top
of the file, and the top of a real export is often a title line with no
delimiter in it — at which point it guesses a comma, the file collapses into
one column, and the error the user sees is "missing required field: title".
Instead each candidate is scored by how many lines it splits into the same
number of fields, so the body decides and the preamble contributes nothing.

Overrides, when a guess is wrong:

```bash
npm run ingest -- inspect file.csv --delimiter ';' --encoding cp1252 --skip-rows 3
```

## Mapping

A column called "Summary", "Title" or "Task name" all mean the same thing. The
importer proposes a mapping from the header names and the user corrects it
once; the result is stored on the data source, so the next upload from the
same place needs no mapping step.

The same code maps all three of these with no configuration:

| Jira         | Construction      | Interior design | →              |
| ------------ | ----------------- | --------------- | -------------- |
| Issue key    | Ref               | Item #          | `external_id`  |
| Summary      | Task name         | Description     | `title`        |
| Status       | Inspection status | Stage           | `status`       |
| Assignee     | Responsible       | —               | `assignee`     |
| Resolved     | Actual finish     | —               | `completed_at` |
| Story Points | Days              | —               | `estimate`     |

Matching runs in two passes — every exact alias match first, then whole-token
substrings. One pass lets a loose hit on an early field steal a column that a
later field matches exactly.

**Unmapped columns are not an error.** They are preserved verbatim in
`work_items.metadata`, so nothing is lost on a first pass and the user can see
what is still unmapped.

Override a column:

```bash
npm run ingest -- dry-run file.csv --map "Trade=type" --map "Notes=description" --map "Cost=ignore"
```

### Taxonomy values

`status`, `type`, `priority` and `severity` resolve against the taxonomy rather
than being written as text. A value matching no term is **reported, never
auto-created** — a typo'd status that quietly becomes a new term corrupts every
flow metric that groups by status category.

Matching is case- and space-insensitive, so "In Progress", "in_progress" and
"in progress" all find the same term.

## Validation and the reject ledger

A bad row never aborts the import and never disappears. It goes to
`ingestion_rejects` with its row number, the raw values the user actually
wrote, and a reason meant for whoever has to fix the spreadsheet:

```
row 7:  title is empty (column "Task name")
row 9:  completed (2026-04-03) is before created (2026-04-12)
row 10: Date raised: cannot parse "not a date" as a date
```

Row numbers count the preamble and the header, so they match what the user
sees in their spreadsheet.

Only a structural failure — unreadable file, no header — stops everything,
because at that point there is nothing to continue with.

**Dates are parsed day-first.** `03/04/2026` is 3 April. This is wrong either
way for somebody, so it is stated rather than left to the library.

**A row whose own dates contradict each other is rejected.** Accepting it would
put a negative cycle time on a chart with no clue which import caused it.

### The reject threshold

Above 25% rejected (configurable with `--max-reject-ratio`) the run fails and
reports the mapping as the likely cause. A file that imports 3% of itself and
reports success is worse than one that fails.

## Idempotency

Re-uploading last week's export with this week's rows added must not duplicate
anything. Rows upsert on `(source, external_id)`, which has a unique index.

When the source has no stable identifier, one is derived by hashing the row's
**content** — not its position. Re-uploading a file with rows inserted above
therefore does not re-key, and so does not duplicate, everything below it.

An import only writes the columns it owns, and **never overwrites a value a
human set in the app with a null from a CSV that lacks that column**. The
upsert uses `coalesce(excluded.x, work_items.x)` throughout, and `metadata` is
merged rather than replaced so an earlier import's extra columns survive a
later file that happens not to include them.

Per-row outcome is reported as inserted / updated / unchanged. A second run of
an unchanged file reports everything as unchanged.

## History

Cycle time, lead time and the cumulative flow diagram are all derived from
`status_transitions`, because a table holding only the current status cannot
say how long something sat in review.

So the importer builds the history a CSV implies:

- Timestamp columns (created, started, resolved) become transitions on first
  insert.
- A later import that **changes** an item's status appends a transition for
  the change.
- Steps are clamped forward so history can never contradict the item's own
  columns — the same monotonicity rule the seed follows.
- A duplicate transition is a no-op: the schema has a unique index on
  `(work_item_id, to_status, occurred_at)` and the insert cooperates with it
  via `on conflict do nothing`, so re-importing is safe rather than a crash.

**A CSV carrying only current status produces no history.** That is honest, not
a bug — there is nothing to reconstruct from. Those items will not appear in
the cumulative flow diagram or in cycle-time statistics, and the run summary
says so explicitly:

```
3 item(s) carry no dates, so no history could be built -- cycle time and
the cumulative flow diagram will not include them
```

If your export has date columns, map them. It is the single highest-value
thing you can do for the charts.

## Adding a connector

Implement `Connector` in `apps/ingestion/src/pmdash_ingest/connector.py`:

```python
@register
class JiraConnector(Connector):
    kind = "jira"                      # must match the source_kind enum

    def discover(self) -> SourceInfo:
        """Cheap: columns and a row count, enough to drive a mapping screen."""

    def fetch(self, since=None) -> Iterator[SourceRow]:
        """Stream rows. An iterator, not a list."""
```

A connector's job is narrow: produce rows, and say what it knows about them.
Validation, taxonomy resolution, upserting, transition synthesis, the reject
ledger and run bookkeeping are shared and live in `pipeline.py`. A connector
that reimplements any of that is doing too much — and will drift from the CSV
one in ways nobody notices until the numbers disagree.

`source_kind` already enumerates `github`, `jira`, `linear` and `asana`, so
adding one is a code change here and not a migration.

### Credentials

**Never put a secret in `data_sources.config`.** That column is backed up and
this repository is public. A connector declares the _name_ of the environment
variable holding its token and resolves it at run time:

```python
config = {"base_url": "https://example.atlassian.net", "token_env": "JIRA_API_TOKEN"}
token = resolve_secret(config, "token_env")   # reads $JIRA_API_TOKEN
```

`resolve_secret` raises if the named variable is unset, rather than quietly
making an unauthenticated request that fails later with a confusing error.

Logs redact anything that looks like a credential at the serialiser, not at
each call site — doing it per call site works right up until somebody forgets.

## Bookkeeping

Every run writes a row to `ingestion_runs`: status, dry-run flag, counts,
duration, the correlation id, and a `stats` object. Rejected rows reference it.

Logs go to `logs/ingestion.log` as line-delimited JSON in the shared schema, so
one correlation id reconstructs an operation across every tier:

```bash
jq 'select(.correlation_id=="a1b2c3")' logs/*.log
```

## Testing

```bash
npm run ingest:test          # 44 fast tests, no database
npm run ingest:test -- -m db # 6 end-to-end, needs Postgres
```

The end-to-end suite asserts the things that only show up once rows land:
a dry run leaves the database byte-identical, a re-import duplicates nothing
(items _or_ transitions), rejects reach the ledger with their raw row, and
imported data satisfies the same integrity rules as seeded data.
