"""
Database access for the importer.

Two things here are subtle enough to be worth reading before changing:

1. **Upserts must not clobber human edits with CSV nulls.** A source that
   lacks a column must leave that column alone, not blank it. The SQL below
   uses `coalesce(excluded.x, work_items.x)` for exactly this.

2. **Status changes have to be recorded as transitions.** Cycle time, lead
   time and the cumulative flow diagram are all derived from
   `status_transitions`; a row whose status changes without a transition is
   invisible to every flow chart. See `synthesise_transitions`.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Run ./scripts/preflight.sh to generate .env, "
            "then source it or run via ./scripts/dev.sh."
        )
    return url


@contextmanager
def connect(*, autocommit: bool = False):
    """A connection with dict rows. Callers manage the transaction."""
    with psycopg.connect(database_url(), row_factory=dict_row, autocommit=autocommit) as conn:
        yield conn


# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Taxonomy:
    """
    Term lookup for one taxonomy, by slug and by label.

    Matching is case- and space-insensitive because a source writes "In
    Progress" where the term is "in_progress" and a human typed "in progress".
    Archived terms still resolve: historical rows legitimately reference them,
    and refusing would reject data that is perfectly valid history.
    """

    key: str
    by_key: dict[str, str]
    status_category: dict[str, str]
    #: term id -> display label. status_transitions stores the label as well as
    #: the id, so history stays readable if a term is later renamed.
    labels: dict[str, str]

    @staticmethod
    def _norm(value: str) -> str:
        return " ".join(value.split()).casefold().replace("_", " ")

    def resolve(self, value: str | None) -> str | None:
        if not value:
            return None
        return self.by_key.get(self._norm(value))

    def category_of(self, term_id: str | None) -> str | None:
        return self.status_category.get(term_id) if term_id else None

    def label_of(self, term_id: str | None) -> str | None:
        return self.labels.get(term_id) if term_id else None


def load_taxonomy(conn: psycopg.Connection, key: str) -> Taxonomy:
    rows = conn.execute(
        """
        select tt.id, tt.slug, tt.label, tt.status_category
        from taxonomy_terms tt
        join taxonomies t on t.id = tt.taxonomy_id
        where t.key = %s
        """,
        (key,),
    ).fetchall()

    by_key: dict[str, str] = {}
    categories: dict[str, str] = {}
    labels: dict[str, str] = {}
    for r in rows:
        tid = str(r["id"])
        for candidate in (r["slug"], r["label"]):
            if candidate:
                by_key[Taxonomy._norm(candidate)] = tid
        if r["status_category"]:
            categories[tid] = r["status_category"]
        labels[tid] = r["label"] or r["slug"]
    return Taxonomy(key=key, by_key=by_key, status_category=categories, labels=labels)


def resolve_person(conn: psycopg.Connection, name: str | None) -> str | None:
    """
    Finds a person by display name or email. Does not create one.

    Creating people from a CSV would turn every typo'd name into a new team
    member, and the roster would quietly become unusable. Unmatched names are
    kept in metadata instead, so the information survives without polluting
    the table.
    """
    if not name:
        return None
    row = conn.execute(
        """
        select id from people
        where lower(display_name) = lower(%s) or lower(email) = lower(%s)
        limit 1
        """,
        (name.strip(), name.strip()),
    ).fetchone()
    return str(row["id"]) if row else None


def resolve_project(conn: psycopg.Connection, key_or_name: str | None) -> str | None:
    if not key_or_name:
        return None
    row = conn.execute(
        "select id from projects where lower(key) = lower(%s) or lower(name) = lower(%s) limit 1",
        (key_or_name.strip(), key_or_name.strip()),
    ).fetchone()
    return str(row["id"]) if row else None


# ---------------------------------------------------------------------------
# Data sources and runs
# ---------------------------------------------------------------------------


def get_or_create_source(
    conn: psycopg.Connection, *, name: str, kind: str, config: dict[str, Any]
) -> dict[str, Any]:
    row = conn.execute("select * from data_sources where name = %s", (name,)).fetchone()
    if row:
        return row
    return conn.execute(
        """
        insert into data_sources (name, kind, config, enabled)
        values (%s, %s, %s, true)
        returning *
        """,
        (name, kind, psycopg.types.json.Jsonb(config)),
    ).fetchone()


def save_source_config(conn: psycopg.Connection, source_id: str, config: dict[str, Any]) -> None:
    """
    Persists the mapping profile so the next upload needs no mapping step.

    Never store a credential here. This column is backed up and the repository
    is public; connectors reference an environment variable name instead. See
    connector.resolve_secret.
    """
    conn.execute(
        "update data_sources set config = %s, updated_at = now() where id = %s",
        (psycopg.types.json.Jsonb(config), source_id),
    )


def start_run(
    conn: psycopg.Connection,
    *,
    source_id: str,
    kind: str,
    correlation_id: str,
    dry_run: bool,
    source_file: str | None,
) -> str:
    row = conn.execute(
        """
        insert into ingestion_runs
          (data_source_id, correlation_id, kind, status, dry_run, source_file, started_at)
        values (%s, %s, %s, 'running', %s, %s, now())
        returning id
        """,
        (source_id, correlation_id, kind, dry_run, source_file),
    ).fetchone()
    return str(row["id"])


def finish_run(
    conn: psycopg.Connection,
    run_id: str,
    *,
    status: str,
    rows_read: int,
    rows_upserted: int,
    rows_rejected: int,
    stats: dict[str, Any],
    error: str | None = None,
) -> None:
    conn.execute(
        """
        update ingestion_runs
        set status = %s, finished_at = now(), rows_read = %s, rows_upserted = %s,
            rows_rejected = %s, stats = %s, error = %s
        where id = %s
        """,
        (
            status,
            rows_read,
            rows_upserted,
            rows_rejected,
            psycopg.types.json.Jsonb(stats),
            error,
            run_id,
        ),
    )


def record_reject(
    conn: psycopg.Connection,
    *,
    run_id: str,
    row_number: int,
    raw: dict[str, Any],
    reason: str,
) -> None:
    conn.execute(
        """
        insert into ingestion_rejects (ingestion_run_id, row_number, raw, reason)
        values (%s, %s, %s, %s)
        """,
        (run_id, row_number, psycopg.types.json.Jsonb(raw), reason),
    )


# ---------------------------------------------------------------------------
# Work items
# ---------------------------------------------------------------------------

#: Columns an import owns. Anything not listed is never written by an import,
#: so a field a human set in the app cannot be overwritten from a spreadsheet.
UPSERT_SQL = """
insert into work_items (
    project_id, key, title, description, status_term_id, status_raw, status_category,
    type_term_id, priority_term_id, estimate, assignee_id, reporter_id,
    source_created_at, started_at, completed_at, due_date, labels,
    is_blocked, blocked_reason, metadata, source, external_id, ingestion_run_id
) values (
    %(project_id)s, %(key)s, %(title)s, %(description)s, %(status_term_id)s,
    %(status_raw)s, %(status_category)s, %(type_term_id)s, %(priority_term_id)s,
    %(estimate)s, %(assignee_id)s, %(reporter_id)s, %(source_created_at)s,
    %(started_at)s, %(completed_at)s, %(due_date)s, %(labels)s,
    %(is_blocked)s, %(blocked_reason)s, %(metadata)s, %(source)s, %(external_id)s,
    %(ingestion_run_id)s
)
on conflict (source, external_id) do update set
    -- coalesce(excluded, existing) throughout: a column the CSV does not carry
    -- arrives as NULL, and overwriting a human's edit with it would be data
    -- loss dressed up as an import.
    title            = coalesce(excluded.title, work_items.title),
    description      = coalesce(excluded.description, work_items.description),
    status_term_id   = coalesce(excluded.status_term_id, work_items.status_term_id),
    status_raw       = coalesce(excluded.status_raw, work_items.status_raw),
    status_category  = coalesce(excluded.status_category, work_items.status_category),
    type_term_id     = coalesce(excluded.type_term_id, work_items.type_term_id),
    priority_term_id = coalesce(excluded.priority_term_id, work_items.priority_term_id),
    estimate         = coalesce(excluded.estimate, work_items.estimate),
    assignee_id      = coalesce(excluded.assignee_id, work_items.assignee_id),
    reporter_id      = coalesce(excluded.reporter_id, work_items.reporter_id),
    source_created_at = coalesce(excluded.source_created_at, work_items.source_created_at),
    started_at       = coalesce(excluded.started_at, work_items.started_at),
    completed_at     = coalesce(excluded.completed_at, work_items.completed_at),
    due_date         = coalesce(excluded.due_date, work_items.due_date),
    labels           = case when excluded.labels = '{}' then work_items.labels
                            else excluded.labels end,
    is_blocked       = excluded.is_blocked,
    blocked_reason   = coalesce(excluded.blocked_reason, work_items.blocked_reason),
    -- Merge rather than replace, so an earlier import's extra columns survive
    -- a later file that happens not to include them.
    metadata         = work_items.metadata || excluded.metadata,
    ingestion_run_id = excluded.ingestion_run_id,
    updated_at       = now()
returning id, (xmax = 0) as inserted,
          status_term_id, status_category, source_created_at, started_at, completed_at
"""


def fetch_existing(
    conn: psycopg.Connection, source: str, external_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """
    Current state of the rows about to be written.

    Needed to tell an insert from an update, and to know an item's previous
    status so a change can be recorded as a transition.
    """
    if not external_ids:
        return {}
    rows = conn.execute(
        """
        -- Must select every column `_changed` compares. Selecting fewer made
        -- the missing ones read as NULL, so every re-import looked like an
        -- update and the "unchanged" count was never reachable.
        select external_id, id, status_term_id, status_category,
               title, description, estimate,
               source_created_at, started_at, completed_at
        from work_items
        where source = %s and external_id = any(%s)
        """,
        (source, external_ids),
    ).fetchall()
    # UUIDs come back as uuid.UUID while everything downstream compares against
    # strings, so `before["status_term_id"] != status_term` was true even when
    # the status had not moved -- which made every re-import try to re-insert
    # the same transitions. Normalise at the boundary.
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        row = dict(r)
        for key in ("id", "status_term_id"):
            if row.get(key) is not None:
                row[key] = str(row[key])
        # numeric comes back as Decimal; the parsed row carries a float, and
        # Decimal("3.50") != 3.5 would read as a change forever.
        if row.get("estimate") is not None:
            row["estimate"] = float(row["estimate"])
        out[row["external_id"]] = row
    return out


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------


def synthesise_transitions(
    *,
    work_item_id: str,
    project_id: str | None,
    created_at: datetime | None,
    started_at: datetime | None,
    completed_at: datetime | None,
    status_term_id: str | None,
    status_category: str | None,
    workflow: Taxonomy,
    defaults: dict[str, str | None],
    run_id: str,
) -> list[dict[str, Any]]:
    """
    Builds the history a CSV implies, from the timestamps it carries.

    Without this, imported items have no transitions and every flow chart is
    blank for them: the cumulative flow diagram, cycle time and lead time are
    all derived from `status_transitions`, because a table holding only the
    current status cannot say how long something sat in review.

    Only transitions the data actually supports are created. A file with no
    dates yields none -- which is honest, and documented, rather than
    invented. Monotonicity is enforced the same way the seed does it: each step
    is clamped to be no earlier than the one before, so history can never
    contradict the item's own columns.
    """
    steps: list[tuple[datetime, str, str | None]] = []

    if started_at and defaults.get("in_progress"):
        steps.append((started_at, "in_progress", defaults["in_progress"]))
    if completed_at and defaults.get("done"):
        steps.append((completed_at, "done", defaults["done"]))

    # An item whose current status is neither of those still needs its present
    # state recorded, otherwise the CFD loses it entirely.
    if status_category and status_category not in {s[1] for s in steps} and status_term_id:
        at = completed_at or started_at or created_at
        if at:
            steps.append((at, status_category, status_term_id))

    if not steps:
        return []

    steps.sort(key=lambda s: s[0])

    transitions: list[dict[str, Any]] = []
    prev_at = created_at
    prev_term: str | None = defaults.get("todo")
    prev_cat: str | None = "todo" if defaults.get("todo") else None

    for at, category, term_id in steps:
        # Clamp forward: a source whose "resolved" precedes its "started" has
        # already been rejected, but a derived step can still land equal, and
        # an out-of-order pair would break the integrity checks.
        occurred = at if prev_at is None or at >= prev_at else prev_at
        duration = (
            int((occurred - prev_at).total_seconds()) if prev_at is not None else None
        )
        transitions.append(
            {
                "work_item_id": work_item_id,
                "project_id": project_id,
                "from_term_id": prev_term,
                "to_term_id": term_id,
                # from_status/to_status are NOT NULL: the label is stored
                # alongside the id so history stays readable after a rename.
                "from_status": workflow.label_of(prev_term),
                "to_status": workflow.label_of(term_id) or category,
                "from_category": prev_cat,
                "to_category": category,
                "occurred_at": occurred,
                "duration_in_from_seconds": duration,
                "ingestion_run_id": run_id,
            }
        )
        prev_at, prev_term, prev_cat = occurred, term_id, category

    return transitions


def insert_transitions(conn: psycopg.Connection, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into status_transitions
              (work_item_id, project_id, from_term_id, to_term_id,
               from_status, to_status, from_category,
               to_category, occurred_at, duration_in_from_seconds, ingestion_run_id)
            values
              (%(work_item_id)s, %(project_id)s, %(from_term_id)s, %(to_term_id)s,
               %(from_status)s, %(to_status)s, %(from_category)s,
               %(to_category)s, %(occurred_at)s,
               %(duration_in_from_seconds)s, %(ingestion_run_id)s)
            -- The schema already guards against a duplicate transition with
            -- transitions_dedupe_idx. Cooperate with it rather than relying on
            -- the caller never trying: re-importing the same file must be a
            -- no-op, not a crash, and the caller cannot always know whether
            -- equivalent history arrived from somewhere else.
            on conflict (work_item_id, to_status, occurred_at) do nothing
            """,
            rows,
        )
        # rowcount reflects what was actually written, so the reported figure
        # is inserts rather than attempts.
        return max(0, cur.rowcount)


def existing_transition_count(conn: psycopg.Connection, work_item_id: str) -> int:
    row = conn.execute(
        "select count(*)::int as n from status_transitions where work_item_id = %s",
        (work_item_id,),
    ).fetchone()
    return int(row["n"])


def workflow_defaults(conn: psycopg.Connection) -> dict[str, str | None]:
    """
    One representative term per status category.

    Used when synthesising history: a CSV says an item was resolved on a date
    but not which "done" column it landed in, so the first done-category term
    in display order stands in. Deterministic by sort order, so two imports of
    the same file agree.
    """
    rows = conn.execute(
        """
        select distinct on (tt.status_category)
               tt.status_category, tt.id
        from taxonomy_terms tt
        join taxonomies t on t.id = tt.taxonomy_id
        where t.key = 'workflow_status' and tt.status_category is not null
          and tt.archived_at is null
        order by tt.status_category, tt.sort_order
        """
    ).fetchall()
    return {r["status_category"]: str(r["id"]) for r in rows}
