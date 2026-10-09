"""
The import pipeline: parse, map, validate, resolve, upsert, record.

Shared by every connector. A connector produces rows; everything that decides
what those rows *mean* happens here, once, so a second source cannot acquire
subtly different behaviour.

Dry run is not a separate code path. It runs the identical pipeline inside a
transaction that is rolled back, because a dry run that exercises different
code is a dry run that can disagree with the real thing — which is the one
thing it must never do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import psycopg

from . import db
from .connector import Connector, SourceRow
from .logs import Logger, Timer
from .mapping import TAXONOMY_FIELDS, Mapping, propose, report
from .models import build_row

#: Above this share of rejects the run is treated as a mis-mapped file rather
#: than a few bad rows, and exits non-zero. A file that imports 3% of itself
#: and reports success is worse than one that fails.
DEFAULT_MAX_REJECT_RATIO = 0.25


@dataclass
class Outcome:
    """What a run did, or would have done."""

    run_id: str | None = None
    correlation_id: str = ""
    dry_run: bool = False
    rows_read: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    rejected: int = 0
    transitions: int = 0
    #: (row_number, reason), capped for display; all of them go to the ledger.
    rejects: list[tuple[int, str]] = field(default_factory=list)
    #: Values in a taxonomy field that matched no term, with a count each.
    unknown_terms: dict[str, dict[str, int]] = field(default_factory=dict)
    #: People named in the file who are not in the roster.
    unknown_people: set[str] = field(default_factory=set)
    items_without_history: int = 0
    aborted: str | None = None

    @property
    def upserted(self) -> int:
        return self.inserted + self.updated + self.unchanged

    @property
    def reject_ratio(self) -> float:
        return self.rejected / self.rows_read if self.rows_read else 0.0

    def summary(self) -> str:
        head = "Would import" if self.dry_run else "Imported"
        lines = [
            f"{head}: {self.rows_read} rows read, {self.inserted} inserted, "
            f"{self.updated} updated, {self.unchanged} unchanged, {self.rejected} rejected",
        ]
        if self.transitions:
            lines.append(f"  history: {self.transitions} status transitions synthesised")
        if self.items_without_history:
            lines.append(
                f"  {self.items_without_history} item(s) carry no dates, so no history "
                "could be built -- cycle time and the cumulative flow diagram "
                "will not include them"
            )
        for fld, values in sorted(self.unknown_terms.items()):
            shown = ", ".join(f"{v} ({n})" for v, n in sorted(values.items())[:6])
            more = "" if len(values) <= 6 else f", +{len(values) - 6} more"
            lines.append(f"  unknown {fld}: {shown}{more}")
        if self.unknown_people:
            shown = ", ".join(sorted(self.unknown_people)[:6])
            lines.append(f"  not in the roster (kept in metadata): {shown}")
        if self.rejects:
            lines.append("  first rejects:")
            for row_number, reason in self.rejects[:8]:
                lines.append(f"    row {row_number}: {reason}")
            if self.rejected > 8:
                lines.append(f"    ... and {self.rejected - 8} more in ingestion_rejects")
        return "\n".join(lines)


def run_import(
    *,
    connector: Connector,
    source_name: str,
    dry_run: bool = True,
    mapping: Mapping | None = None,
    project_key: str | None = None,
    max_reject_ratio: float = DEFAULT_MAX_REJECT_RATIO,
    log: Logger | None = None,
    save_mapping: bool = True,
) -> Outcome:
    """
    Executes one import.

    `dry_run` defaults to True. Writing to someone's database is tedious to
    undo, so the safe thing is what happens when the caller says nothing.
    """
    log = log or Logger()
    outcome = Outcome(dry_run=dry_run, correlation_id=log.correlation_id)

    with Timer(log, "discover", source=source_name):
        info = connector.discover()
    log.event(
        "discovered",
        columns=len(info.columns),
        rows=info.row_count,
        **{k: v for k, v in info.details.items() if k != "path"},
    )
    for warning in info.warnings:
        log.event("source_warning", level="warn", message=warning)

    with db.connect() as conn:
        source = db.get_or_create_source(
            conn, name=source_name, kind=connector.kind, config=dict(connector.config)
        )
        source_id = str(source["id"])

        resolved = mapping or Mapping.from_config(source.get("config"))
        if not resolved.columns:
            resolved = propose(info.columns)
            log.event("mapping_proposed", mapped=len(resolved.columns))

        mapping_report = report(info.columns, resolved)
        if not mapping_report.ok:
            outcome.aborted = (
                "Mapping is missing required field(s): "
                + ", ".join(mapping_report.missing_required)
            )
            log.event("aborted", level="error", reason=outcome.aborted)
            conn.rollback()
            return outcome

        run_id = db.start_run(
            conn,
            source_id=source_id,
            kind=connector.kind,
            correlation_id=log.correlation_id,
            dry_run=dry_run,
            source_file=info.details.get("path"),
        )
        outcome.run_id = run_id
        log.event("run_started", run_id=run_id, dry_run=dry_run)

        try:
            _process(
                conn=conn,
                connector=connector,
                mapping=resolved,
                source_name=source_name,
                project_key=project_key,
                run_id=run_id,
                outcome=outcome,
                log=log,
            )

            status = "succeeded"
            if outcome.rejected and outcome.reject_ratio > max_reject_ratio:
                status = "failed"
                outcome.aborted = (
                    f"{outcome.rejected} of {outcome.rows_read} rows rejected "
                    f"({outcome.reject_ratio:.0%}), above the {max_reject_ratio:.0%} "
                    "threshold. The mapping is probably wrong."
                )
            elif outcome.rejected:
                status = "partial"

            db.finish_run(
                conn,
                run_id,
                status=status,
                rows_read=outcome.rows_read,
                rows_upserted=outcome.upserted,
                rows_rejected=outcome.rejected,
                stats={
                    "inserted": outcome.inserted,
                    "updated": outcome.updated,
                    "unchanged": outcome.unchanged,
                    "transitions": outcome.transitions,
                    "unknown_terms": {k: sorted(v) for k, v in outcome.unknown_terms.items()},
                    "items_without_history": outcome.items_without_history,
                },
                error=outcome.aborted,
            )

            if save_mapping and not dry_run:
                config = dict(source.get("config") or {})
                config["mapping"] = resolved.to_config()
                db.save_source_config(conn, source_id, config)

            if dry_run:
                # The whole point: every write above is discarded, including
                # the run row and the rejects, so a dry run leaves the database
                # byte-identical.
                conn.rollback()
                log.event("rolled_back", reason="dry run")
            else:
                conn.commit()
                log.event("committed", **{"rows": outcome.upserted})

        except Exception as exc:
            conn.rollback()
            log.event("run_failed", level="error", error=str(exc))
            outcome.aborted = str(exc)
            # Record the failure outside the rolled-back transaction, so the
            # run row survives to be investigated.
            with db.connect(autocommit=True) as c2:
                db.finish_run(
                    c2,
                    run_id,
                    status="failed",
                    rows_read=outcome.rows_read,
                    rows_upserted=0,
                    rows_rejected=outcome.rejected,
                    stats={},
                    error=str(exc),
                )
            raise

    return outcome


def _process(
    *,
    conn: psycopg.Connection,
    connector: Connector,
    mapping: Mapping,
    source_name: str,
    project_key: str | None,
    run_id: str,
    outcome: Outcome,
    log: Logger,
) -> None:
    taxonomies = {
        fld: db.load_taxonomy(conn, tax_key) for fld, tax_key in TAXONOMY_FIELDS.items()
    }
    defaults = db.workflow_defaults(conn)
    default_project = db.resolve_project(conn, project_key) if project_key else None

    person_cache: dict[str, str | None] = {}
    project_cache: dict[str, str | None] = {}

    batch: list[SourceRow] = []
    BATCH = 500

    def flush(rows: list[SourceRow]) -> None:
        if not rows:
            return
        prepared: list[tuple[SourceRow, Any]] = []
        for src in rows:
            try:
                prepared.append(
                    (
                        src,
                        build_row(
                            values=src.values,
                            mapping_columns=mapping.columns,
                            row_number=src.row_number,
                            source_name=source_name,
                            external_id=src.external_id,
                        ),
                    )
                )
            except ValueError as exc:
                outcome.rejected += 1
                outcome.rejects.append((src.row_number, str(exc)))
                db.record_reject(
                    conn,
                    run_id=run_id,
                    row_number=src.row_number,
                    raw=src.values,
                    reason=str(exc),
                )

        if not prepared:
            return

        existing = db.fetch_existing(conn, "csv", [p[1].external_id for p in prepared])

        for src, row in prepared:
            # -- taxonomy ---------------------------------------------------
            term_ids: dict[str, str | None] = {}
            for fld, tax in taxonomies.items():
                raw_value = getattr(row, fld, None)
                term_id = tax.resolve(raw_value)
                if raw_value and term_id is None:
                    outcome.unknown_terms.setdefault(fld, {})
                    outcome.unknown_terms[fld][raw_value] = (
                        outcome.unknown_terms[fld].get(raw_value, 0) + 1
                    )
                term_ids[fld] = term_id

            status_term = term_ids.get("status")
            status_category = taxonomies["status"].category_of(status_term)

            # -- people and project ----------------------------------------
            def person(name: str | None) -> str | None:
                if not name:
                    return None
                if name not in person_cache:
                    person_cache[name] = db.resolve_person(conn, name)
                    if person_cache[name] is None:
                        outcome.unknown_people.add(name)
                return person_cache[name]

            project_id = default_project
            if row.project:
                if row.project not in project_cache:
                    project_cache[row.project] = db.resolve_project(conn, row.project)
                project_id = project_cache[row.project] or default_project

            if project_id is None:
                reason = (
                    "no project: the row names none and no --project was given"
                    if not row.project
                    else f'unknown project "{row.project}"'
                )
                outcome.rejected += 1
                outcome.rejects.append((src.row_number, reason))
                db.record_reject(
                    conn, run_id=run_id, row_number=src.row_number,
                    raw=src.values, reason=reason,
                )
                continue

            # Unmatched names are preserved rather than dropped.
            metadata = dict(row.metadata)
            assignee_id = person(row.assignee)
            if row.assignee and assignee_id is None:
                metadata["_unmatched_assignee"] = row.assignee
            reporter_id = person(row.reporter)
            if row.reporter and reporter_id is None:
                metadata["_unmatched_reporter"] = row.reporter

            params = {
                "project_id": project_id,
                "key": row.external_id[:64],
                "title": row.title,
                "description": row.description,
                "status_term_id": status_term,
                "status_raw": row.status,
                "status_category": status_category or "todo",
                "type_term_id": term_ids.get("type"),
                "priority_term_id": term_ids.get("priority"),
                "estimate": row.estimate,
                "assignee_id": assignee_id,
                "reporter_id": reporter_id,
                "source_created_at": row.source_created_at,
                "started_at": row.started_at,
                "completed_at": row.completed_at,
                "due_date": row.due_date,
                "labels": row.labels,
                "is_blocked": status_category == "blocked",
                "blocked_reason": row.blocked_reason,
                "metadata": psycopg.types.json.Jsonb(metadata),
                "source": "csv",
                "external_id": row.external_id,
                "ingestion_run_id": run_id,
            }

            before = existing.get(row.external_id)
            result = conn.execute(db.UPSERT_SQL, params).fetchone()
            item_id = str(result["id"])

            if result["inserted"]:
                outcome.inserted += 1
            elif before and _changed(before, params):
                outcome.updated += 1
            else:
                outcome.unchanged += 1

            # -- history ----------------------------------------------------
            # Only on insert, or when the status actually moved. Re-running an
            # import must not append a duplicate transition for every row.
            status_moved = bool(
                before and status_term and before.get("status_term_id") != status_term
            )
            if result["inserted"] or status_moved:
                if result["inserted"] and db.existing_transition_count(conn, item_id):
                    pass  # already has history from elsewhere; leave it alone
                else:
                    transitions = db.synthesise_transitions(
                        work_item_id=item_id,
                        project_id=project_id,
                        created_at=row.source_created_at,
                        started_at=row.started_at,
                        completed_at=row.completed_at,
                        status_term_id=status_term,
                        status_category=status_category,
                        workflow=taxonomies["status"],
                        defaults=defaults,
                        run_id=run_id,
                    )
                    if transitions:
                        outcome.transitions += db.insert_transitions(conn, transitions)
                    elif result["inserted"]:
                        outcome.items_without_history += 1

    with Timer(log, "rows_processed", source=source_name):
        for src in connector.fetch():
            outcome.rows_read += 1
            batch.append(src)
            if len(batch) >= BATCH:
                flush(batch)
                batch = []
                log.event("progress", read=outcome.rows_read, rejected=outcome.rejected)
        flush(batch)


#: Columns compared to tell a real update from a no-op re-import.
_COMPARED = (
    "title", "description", "status_term_id", "estimate",
    "source_created_at", "started_at", "completed_at",
)


def _changed(before: dict[str, Any], params: dict[str, Any]) -> bool:
    for key in _COMPARED:
        new = params.get(key)
        if new is None:
            continue  # coalesce would have kept the old value
        if before.get(key) != new:
            return True
    return False
