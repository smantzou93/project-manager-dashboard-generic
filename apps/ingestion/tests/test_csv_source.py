"""
Dialect, encoding and header detection.

These are the cases real exports actually produce. Each one was either seen
while building this or is a known shape from Jira / Excel.
"""

from __future__ import annotations

import pytest

from pmdash_ingest.csv_source import (
    CsvConnector,
    _looks_like_header,
    detect_dialect,
    normalise_header,
)


def write(tmp_path, name: str, content: bytes):
    p = tmp_path / name
    p.write_bytes(content)
    return p


def test_plain_comma_file(tmp_path):
    p = write(tmp_path, "a.csv", b"Key,Title,Status\nA-1,Do a thing,Done\n")
    info = CsvConnector({"path": str(p)}).discover()
    assert info.columns == ["Key", "Title", "Status"]
    assert info.row_count == 1
    assert info.details["delimiter"] == ","


def test_semicolons_with_a_bom_and_preamble(tmp_path):
    # Excel writes the BOM; Jira writes the preamble. Both at once is common.
    p = write(
        tmp_path,
        "b.csv",
        "﻿Jira Export\nGenerated today\n\nKey;Title;Status\nA-1;Thing;Done\n".encode(),
    )
    info = CsvConnector({"path": str(p)}).discover()
    assert info.details["encoding"] == "utf-8-sig"
    assert info.details["delimiter"] == ";"
    # The BOM must not end up inside the first column's name -- a header that
    # looks right but never matches a mapping is a miserable thing to debug.
    assert info.columns == ["Key", "Title", "Status"]
    assert info.details["header_row"] == 4
    assert info.row_count == 1


def test_tab_separated(tmp_path):
    p = write(tmp_path, "c.tsv", b"Key\tTitle\tStatus\nA-1\tThing\tDone\n")
    assert CsvConnector({"path": str(p)}).discover().details["delimiter"] == "\t"


def test_latin1_is_readable(tmp_path):
    p = write(tmp_path, "d.csv", "Key,Title\nA-1,Café façade\n".encode("latin-1"))
    rows = list(CsvConnector({"path": str(p)}).fetch())
    assert len(rows) == 1
    assert "Caf" in rows[0].values["Title"]


def test_single_column_file_does_not_raise(tmp_path):
    # csv.Sniffer throws on this. A one-column CSV is valid, not an error.
    p = write(tmp_path, "e.csv", b"Title\nOnly one\nAnother\n")
    info = CsvConnector({"path": str(p)}).discover()
    assert info.columns == ["Title"]
    assert info.row_count == 2


def test_duplicate_headers_are_renamed_not_dropped(tmp_path):
    # Becoming a dict would silently overwrite the first; renaming is visible.
    p = write(tmp_path, "f.csv", b"Name,Name,Status\na,b,Done\n")
    info = CsvConnector({"path": str(p)}).discover()
    assert info.columns == ["Name", "Name_1", "Status"]
    assert any("Duplicate" in w for w in info.warnings)
    assert next(iter(CsvConnector({"path": str(p)}).fetch())).values["Name_1"] == "b"


def test_quoted_delimiter_and_newline(tmp_path):
    p = write(
        tmp_path,
        "g.csv",
        b'Key,Title,Status\nA-1,"Thing, with comma",Done\nA-2,"Two\nlines",Open\n',
    )
    rows = list(CsvConnector({"path": str(p)}).fetch())
    assert rows[0].values["Title"] == "Thing, with comma"
    assert "\n" in rows[1].values["Title"]


def test_blank_lines_are_skipped_but_row_numbers_still_match_the_spreadsheet(tmp_path):
    p = write(tmp_path, "h.csv", b"Key,Title\nA-1,One\n\nA-2,Two\n")
    rows = list(CsvConnector({"path": str(p)}).fetch())
    assert [r.row_number for r in rows] == [2, 4]


def test_cells_beyond_the_header_are_kept(tmp_path):
    # Losing data silently is the one thing this must not do.
    p = write(tmp_path, "i.csv", b"Key,Title\nA-1,One,surprise\n")
    row = next(iter(CsvConnector({"path": str(p)}).fetch()))
    assert "surprise" in row.values.values()


def test_skip_rows_override(tmp_path):
    p = write(tmp_path, "j.csv", b"junk\nmore junk\nKey,Title\nA-1,One\n")
    info = CsvConnector({"path": str(p), "skip_rows": 2}).discover()
    assert info.columns == ["Key", "Title"]


def test_delimiter_override_beats_detection(tmp_path):
    p = write(tmp_path, "k.csv", b"Key|Title\nA-1|One\n")
    info = CsvConnector({"path": str(p), "delimiter": "|"}).discover()
    assert info.columns == ["Key", "Title"]


def test_missing_file_is_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        CsvConnector({"path": str(tmp_path / "nope.csv")})


def test_empty_file_is_rejected(tmp_path):
    p = write(tmp_path, "l.csv", b"")
    with pytest.raises(ValueError, match="empty"):
        CsvConnector({"path": str(p)}).discover()


@pytest.mark.parametrize(
    ("a", "b"),
    [("Due Date", "due_date"), ("DUE  DATE ", "due.date"), ("Task name", "task_name")],
)
def test_header_normalisation_agrees(a, b):
    assert normalise_header(a) == normalise_header(b)


def test_preamble_lines_are_not_mistaken_for_headers():
    assert not _looks_like_header(["Jira Export"])
    assert not _looks_like_header(["", "", ""])
    assert _looks_like_header(["Key", "Title", "Status"])


def test_delimiter_is_chosen_from_the_body_not_the_preamble():
    # The whole reason csv.Sniffer was replaced: it reads from the top, and
    # the top of a real export has no delimiter in it.
    sample = "Some report title\n\nA;B;C\n1;2;3\n4;5;6\n"
    dialect, _ = detect_dialect(sample)
    assert dialect.delimiter == ";"
