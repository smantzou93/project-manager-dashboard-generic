"""Column mapping across domains — the genericity claim, at the importer."""

from __future__ import annotations

from pmdash_ingest.mapping import Mapping, propose, report

JIRA = [
    "Issue key", "Summary", "Status", "Assignee",
    "Created", "Resolved", "Story Points", "Sprint",
]
CONSTRUCTION = [
    "Ref", "Task name", "Inspection status", "Trade",
    "Responsible", "Date raised", "Actual finish", "Days",
]
DESIGN = [
    "Item #", "Description", "Stage", "Room",
    "Supplier", "Ordered", "Delivered", "Cost",
]


def test_maps_a_jira_export():
    m = propose(JIRA)
    assert m.columns["Issue key"] == "external_id"
    assert m.columns["Summary"] == "title"
    assert m.columns["Status"] == "status"
    assert m.columns["Resolved"] == "completed_at"
    assert m.columns["Story Points"] == "estimate"


def test_maps_a_construction_export_with_no_shared_vocabulary():
    # Not one column name in common with the Jira file, same code path.
    m = propose(CONSTRUCTION)
    assert m.columns["Task name"] == "title"
    assert m.columns["Inspection status"] == "status"
    assert m.columns["Responsible"] == "assignee"
    assert m.columns["Date raised"] == "created_at"
    assert m.columns["Actual finish"] == "completed_at"


def test_maps_enough_of_an_interior_design_export_to_proceed():
    m = propose(DESIGN)
    assert report(DESIGN, m).ok, "title must be mappable or the import cannot run"
    assert m.columns["Description"] == "title" or m.columns["Description"] == "description"


def test_each_column_is_claimed_at_most_once():
    m = propose(JIRA + CONSTRUCTION)
    assert len(set(m.columns.values())) == len(m.columns.values())


def test_exact_matches_beat_loose_ones():
    # One pass would let a substring hit on an early field steal a column a
    # later field matches exactly.
    m = propose(["Description", "Short description", "Title"])
    assert m.columns["Title"] == "title"
    assert m.columns["Description"] == "description"


def test_a_whole_token_is_required_so_due_does_not_match_overdue():
    m = propose(["Title", "Overdue flag"])
    assert m.columns.get("Overdue flag") != "due_date"


def test_unmapped_columns_are_reported_not_dropped():
    cols = [*JIRA, "Bespoke Field"]
    rep = report(cols, propose(cols))
    assert "Bespoke Field" in rep.unmapped


def test_missing_title_blocks_the_import():
    rep = report(["Status", "Assignee"], propose(["Status", "Assignee"]))
    assert not rep.ok
    assert "title" in rep.missing_required


def test_taxonomy_fields_are_flagged_for_review():
    rep = report(JIRA, propose(JIRA))
    assert "status" in rep.taxonomy_fields


def test_a_mapping_round_trips_through_the_source_config():
    # This is what lets the second upload need no mapping step.
    original = propose(CONSTRUCTION)
    restored = Mapping.from_config({"mapping": original.to_config()})
    assert restored.columns == original.columns
