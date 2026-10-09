"""Row validation and the derived-key contract."""

from __future__ import annotations

import pytest

from pmdash_ingest.models import build_row, derive_external_id, parse_date, parse_number

MAP = {
    "Key": "external_id",
    "Title": "title",
    "Created": "created_at",
    "Started": "started_at",
    "Done": "completed_at",
    "Points": "estimate",
    "Status": "status",
    "Tags": "labels",
}


def row(**values):
    return build_row(
        values={"Title": "A thing", **values},
        mapping_columns=MAP,
        row_number=2,
        source_name="test",
    )


def test_accepts_a_well_formed_row():
    r = row(Key="A-1", Created="01/02/2026", Done="05/02/2026", Points="3.5", Tags="a, b")
    assert r.external_id == "A-1"
    assert r.estimate == 3.5
    assert r.labels == ["a", "b"]


def test_dates_are_day_first():
    # 03/04 is 3 April here, not 4 March. Stated explicitly because it is
    # wrong either way for somebody.
    assert parse_date("03/04/2026", field_name="x").month == 4


def test_naive_dates_become_utc():
    # Mixing naive and aware datetimes raises at comparison time, a long way
    # from the row that caused it.
    assert parse_date("01/02/2026", field_name="x").tzinfo is not None


def test_placeholder_values_are_treated_as_empty():
    for placeholder in ("", "-", "N/A", "n/a", "TBC", "none"):
        assert row(Key="A-1", Points=placeholder).estimate is None


def test_a_bare_year_is_rejected_rather_than_guessed():
    with pytest.raises(ValueError, match="year, not a date"):
        parse_date("2026", field_name="Created")


def test_numbers_tolerate_separators_and_units():
    assert parse_number("1,250", field_name="x") == 1250
    assert parse_number("3.5 days", field_name="x") == 3.5


@pytest.mark.parametrize(
    "values",
    [
        {"Created": "12/04/2026", "Done": "03/04/2026"},
        {"Started": "12/04/2026", "Done": "03/04/2026"},
        {"Created": "12/04/2026", "Started": "03/04/2026"},
    ],
)
def test_contradictory_timelines_are_rejected(values):
    # Accepting these puts a negative cycle time on a chart with no clue which
    # import caused it.
    with pytest.raises(ValueError, match="before"):
        row(Key="A-1", **values)


def test_an_empty_title_names_the_column():
    with pytest.raises(ValueError, match='column "Title"'):
        build_row(values={"Title": ""}, mapping_columns=MAP, row_number=2, source_name="t")


def test_unmapped_columns_land_in_metadata():
    r = build_row(
        values={"Title": "X", "Zone": "Level 2", "Empty": ""},
        mapping_columns=MAP,
        row_number=2,
        source_name="t",
    )
    assert r.metadata == {"Zone": "Level 2"}


class TestDerivedKeys:
    """The upsert contract depends on these holding."""

    def test_same_content_hashes_the_same(self):
        a = derive_external_id("s", {"Title": "X", "Zone": "L2"}, 2)
        b = derive_external_id("s", {"Zone": "L2", "Title": "X"}, 2)
        assert a == b

    def test_position_does_not_affect_the_key(self):
        # Re-uploading a file with rows inserted above must not re-key, and
        # therefore must not duplicate, everything below it.
        a = derive_external_id("s", {"Title": "X"}, 2)
        b = derive_external_id("s", {"Title": "X"}, 500)
        assert a == b

    def test_different_content_differs(self):
        assert derive_external_id("s", {"Title": "X"}, 2) != derive_external_id(
            "s", {"Title": "Y"}, 2
        )

    def test_different_sources_do_not_collide(self):
        assert derive_external_id("a", {"Title": "X"}, 2) != derive_external_id(
            "b", {"Title": "X"}, 2
        )

    def test_a_wholly_empty_row_still_gets_a_key(self):
        assert derive_external_id("s", {"a": "", "b": ""}, 7)
