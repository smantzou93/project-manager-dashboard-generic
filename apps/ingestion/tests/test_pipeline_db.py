"""
End-to-end against a real database.

Marked `db` so the fast suite skips them. These assert the properties that
only show up once rows actually land: idempotency, the reject ledger, and the
transition history every flow chart depends on.
"""

from __future__ import annotations

import uuid

import pytest

from pmdash_ingest import db
from pmdash_ingest.csv_source import CsvConnector
from pmdash_ingest.logs import Logger
from pmdash_ingest.pipeline import run_import

pytestmark = pytest.mark.db

CSV = b"""Ref,Task name,Inspection status,Responsible,Date raised,Actual finish,Days
T-1,Pour slab,Complete,Mateo Rivera,01/03/2026,10/03/2026,3
T-2,Hang doors,In progress,Priya Raman,05/03/2026,,2
T-3,,Complete,,01/03/2026,02/03/2026,1
"""


@pytest.fixture
def csv_file(tmp_path):
    p = tmp_path / "trades.csv"
    p.write_bytes(CSV)
    return p


@pytest.fixture
def source_name():
    # Unique per test so runs do not collide with each other or with the
    # fixture data the other suites assert against.
    return f"pytest-{uuid.uuid4().hex[:8]}.csv"


def _project_key() -> str:
    with db.connect() as conn:
        row = conn.execute("select key from projects order by key limit 1").fetchone()
        assert row, "no projects: seed the database first"
        return row["key"]


def _cleanup(source_name: str) -> None:
    with db.connect(autocommit=True) as conn:
        conn.execute(
            """
            delete from work_items
            where ingestion_run_id in (
                select r.id from ingestion_runs r
                join data_sources s on s.id = r.data_source_id
                where s.name = %s)
            """,
            (source_name,),
        )
        conn.execute(
            "delete from data_sources where name = %s",
            (source_name,),
        )


def _counts() -> tuple[int, int, int]:
    with db.connect() as conn:
        r = conn.execute(
            """
            select (select count(*) from work_items)::int a,
                   (select count(*) from status_transitions)::int b,
                   (select count(*) from ingestion_runs)::int c
            """
        ).fetchone()
        return r["a"], r["b"], r["c"]


def test_dry_run_changes_absolutely_nothing(csv_file, source_name):
    before = _counts()
    outcome = run_import(
        connector=CsvConnector({"path": str(csv_file)}),
        source_name=source_name,
        dry_run=True,
        project_key=_project_key(),
        max_reject_ratio=0.9,
        log=Logger(),
    )
    assert outcome.inserted == 2
    assert outcome.rejected == 1
    # Including the run row and the rejects. A dry run that leaves bookkeeping
    # behind is not a dry run.
    assert _counts() == before


def test_import_then_reimport_is_idempotent(csv_file, source_name):
    project = _project_key()
    try:
        first = run_import(
            connector=CsvConnector({"path": str(csv_file)}),
            source_name=source_name, dry_run=False, project_key=project,
            max_reject_ratio=0.9, log=Logger(),
        )
        assert first.inserted == 2
        after_first = _counts()

        second = run_import(
            connector=CsvConnector({"path": str(csv_file)}),
            source_name=source_name, dry_run=False, project_key=project,
            max_reject_ratio=0.9, log=Logger(),
        )
        assert second.inserted == 0
        assert second.updated == 0
        assert second.unchanged == 2

        # The count that matters: no duplicated items and, just as important,
        # no duplicated transitions.
        items_after, transitions_after, _ = _counts()
        assert items_after == after_first[0]
        assert transitions_after == after_first[1]
    finally:
        _cleanup(source_name)


def test_rejects_reach_the_ledger_with_a_usable_reason(csv_file, source_name):
    try:
        outcome = run_import(
            connector=CsvConnector({"path": str(csv_file)}),
            source_name=source_name, dry_run=False, project_key=_project_key(),
            max_reject_ratio=0.9, log=Logger(),
        )
        with db.connect() as conn:
            rows = conn.execute(
                "select row_number, reason, raw from ingestion_rejects where ingestion_run_id = %s",
                (outcome.run_id,),
            ).fetchall()
        assert len(rows) == 1
        # Row 4 of the file, as the user's spreadsheet numbers it.
        assert rows[0]["row_number"] == 4
        assert "title" in rows[0]["reason"]
        # The raw row is preserved so the user can see what they wrote.
        assert rows[0]["raw"]["Ref"] == "T-3"
    finally:
        _cleanup(source_name)


def test_history_is_synthesised_so_flow_metrics_work(csv_file, source_name):
    try:
        run_import(
            connector=CsvConnector({"path": str(csv_file)}),
            source_name=source_name, dry_run=False, project_key=_project_key(),
            max_reject_ratio=0.9, log=Logger(),
        )
        with db.connect() as conn:
            rows = conn.execute(
                """
                select wi.title,
                       (select count(*) from status_transitions st
                         where st.work_item_id = wi.id)::int as transitions,
                       wi.status_category::text
                from work_items wi
                where wi.source = 'csv' and wi.title in ('Pour slab', 'Hang doors')
                """
            ).fetchall()
        by_title = {r["title"]: r for r in rows}
        # Without these the cumulative flow diagram and cycle time are blank
        # for imported rows -- the whole reason this step exists.
        assert by_title["Pour slab"]["transitions"] >= 1
        assert by_title["Pour slab"]["status_category"] == "done"
        assert by_title["Hang doors"]["transitions"] >= 1
    finally:
        _cleanup(source_name)


def test_a_mis_mapped_file_fails_loudly_instead_of_importing_a_fraction(tmp_path, source_name):
    bad = tmp_path / "bad.csv"
    bad.write_bytes(b"Task name,Date raised\nOnly good row,01/03/2026\n" + b"Bad,not a date\n" * 9)
    outcome = run_import(
        connector=CsvConnector({"path": str(bad)}),
        source_name=source_name, dry_run=True, project_key=_project_key(),
        max_reject_ratio=0.25, log=Logger(),
    )
    assert outcome.aborted is not None
    assert "threshold" in outcome.aborted


def test_imported_rows_satisfy_the_same_integrity_rules_as_seeded_ones(csv_file, source_name):
    try:
        run_import(
            connector=CsvConnector({"path": str(csv_file)}),
            source_name=source_name, dry_run=False, project_key=_project_key(),
            max_reject_ratio=0.9, log=Logger(),
        )
        with db.connect() as conn:
            r = conn.execute(
                """
                select
                  (select count(*) from work_items
                    where completed_at is not null and started_at is not null
                      and completed_at < started_at)::int as inverted,
                  (select count(*) from work_items
                    where started_at is not null
                      and started_at < source_created_at)::int as early_start,
                  (select count(*) from (
                     select lag(occurred_at) over (partition by work_item_id order by id) prev,
                            occurred_at from status_transitions) t
                    where prev > occurred_at)::int as out_of_order
                """
            ).fetchone()
        assert dict(r) == {"inverted": 0, "early_start": 0, "out_of_order": 0}
    finally:
        _cleanup(source_name)
