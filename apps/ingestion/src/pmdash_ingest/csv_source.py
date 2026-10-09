"""
CSV connector.

Real exports are not tidy. Excel writes a BOM and sometimes semicolons; Jira
puts a preamble above the header; a contractor's spreadsheet arrives as latin-1
with a trailing blank column. None of that is the user's fault, and none of it
should require them to edit the file before importing.

So this sniffs rather than assumes, reports what it found, and lets every
decision be overridden explicitly in the source config when the guess is wrong.
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .connector import Connector, SourceInfo, SourceRow, register

#: Tried in order. utf-8-sig first so an Excel BOM is consumed rather than
#: becoming part of the first column's name -- the classic symptom being a
#: header that looks right but never matches a mapping.
ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

#: Rows scanned when looking for the real header.
HEADER_SCAN_LIMIT = 20

#: Bytes handed to the dialect sniffer. Enough to see several rows, small
#: enough not to read a 200MB file into memory to guess a delimiter.
SNIFF_BYTES = 64 * 1024


def detect_encoding(path: Path) -> str:
    """
    Returns the first encoding that decodes the file's opening block.

    latin-1 is last and decodes any byte sequence, so this always terminates
    with an answer. That is deliberate: a mis-detected encoding produces
    mangled text the user can see and correct, whereas refusing to read the
    file produces nothing they can act on.
    """
    head = path.open("rb").read(SNIFF_BYTES)
    for enc in ENCODINGS:
        try:
            head.decode(enc)
        except UnicodeDecodeError:
            continue
        return enc
    return "latin-1"


def detect_dialect(sample: str) -> tuple[type[csv.Dialect], list[str]]:
    """
    Picks the delimiter by consistency across the sample, not by csv.Sniffer.

    Sniffer reads from the start of the file, and the start of a real export is
    often a title line with no delimiter in it at all -- at which point it
    guesses a comma, the whole file collapses into one column, and the error
    the user sees is "missing required field: title". Which is true, and
    completely unhelpful.

    Instead, each candidate is scored by how many lines it splits into the same
    number of fields. A preamble line yields one field under every candidate
    and so contributes nothing either way, which is exactly the behaviour
    wanted: the body decides.
    """
    warnings: list[str] = []
    lines = [ln for ln in sample.splitlines() if ln.strip()][:HEADER_SCAN_LIMIT]
    if not lines:
        return csv.excel, ["File looks empty; assuming a comma."]

    best_delim, best_score, best_width = ",", 0, 1
    for candidate in (",", ";", "\t", "|"):
        counts: dict[int, int] = {}
        for line in lines:
            # csv.reader rather than str.split, so a delimiter inside a quoted
            # field does not inflate the count.
            try:
                fields = next(csv.reader([line], delimiter=candidate))
            except csv.Error:
                continue
            if len(fields) > 1:
                counts[len(fields)] = counts.get(len(fields), 0) + 1
        if not counts:
            continue
        width, agreeing = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
        # More agreeing lines wins; ties go to the wider split, since a
        # delimiter that finds more columns is finding real structure.
        if (agreeing, width) > (best_score, best_width):
            best_delim, best_score, best_width = candidate, agreeing, width

    if best_score == 0:
        warnings.append("Could not detect a delimiter; assuming a comma. "
                        "Pass --delimiter if the file uses something else.")

    class _Detected(csv.excel):
        delimiter = best_delim

    return _Detected, warnings


def normalise_header(name: str) -> str:
    """
    A comparable key for a column name, for matching only.

    Collapses whitespace, strips punctuation and casefolds, so "Due Date",
    "due_date" and "DUE  DATE " all agree. The original spelling is always kept
    alongside, because that is what the user recognises in a mapping screen.
    """
    cleaned = re.sub(r"[^\w\s]", " ", name)
    return re.sub(r"\s+", "_", cleaned.strip()).casefold()


def _looks_like_header(cells: list[str]) -> bool:
    """
    Heuristic for the real header row.

    Jira and Excel both emit a title or a filter description above the headers.
    A header row is mostly non-empty, mostly non-numeric, and has no duplicates
    among its filled cells -- a data row usually fails at least one.
    """
    filled = [c.strip() for c in cells if c.strip()]
    if len(filled) < 2:
        return False
    if len(filled) < len(cells) / 2:
        return False
    numeric = sum(1 for c in filled if re.fullmatch(r"-?[\d.,]+", c))
    return numeric <= len(filled) / 2
    # Uniqueness is deliberately NOT required. A duplicate header is legal and
    # `_dedupe` already handles it -- requiring it here made the detector skip
    # a real "Name,Name,Status" header and adopt the first data row instead,
    # which is a far worse failure than the one it was guarding against.


def _dedupe(columns: list[str]) -> tuple[list[str], list[str]]:
    """
    Makes column names unique, preserving order.

    A duplicate header silently overwrites the first column when rows become
    dicts, which loses data without any error. Renaming is visible; losing a
    column is not.
    """
    seen: dict[str, int] = {}
    out: list[str] = []
    warnings: list[str] = []
    for col in columns:
        base = col.strip() or "column"
        if base in seen:
            seen[base] += 1
            renamed = f"{base}_{seen[base]}"
            warnings.append(f'Duplicate column "{base}" renamed to "{renamed}".')
            out.append(renamed)
        else:
            seen[base] = 0
            out.append(base)
    return out, warnings


@register
class CsvConnector(Connector):
    """
    Reads a delimited text file.

    Config keys, all optional -- each one overrides a guess:
      path      (required) the file to read
      encoding  skip detection
      delimiter skip dialect sniffing
      skip_rows force a preamble length instead of searching for the header
    """

    kind = "csv"

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        path = config.get("path")
        if not path:
            raise ValueError('A csv source needs a "path" in its config.')
        self.path = Path(path).expanduser()
        if not self.path.is_file():
            raise FileNotFoundError(f"No such file: {self.path}")

        self._encoding: str | None = config.get("encoding")
        self._handle: io.TextIOWrapper | None = None

    # -- internals ---------------------------------------------------------

    def _open(self) -> io.TextIOWrapper:
        if self._encoding is None:
            self._encoding = detect_encoding(self.path)
        # newline="" is required by the csv module: it must see the raw line
        # endings to handle a quoted field containing a newline.
        return self.path.open("r", encoding=self._encoding, newline="")

    def _prepare(self) -> tuple[list[str], int, csv.Dialect | type[csv.Dialect], list[str]]:
        """Resolves dialect, header row index and column names. Reads only the head."""
        warnings: list[str] = []
        with self._open() as fh:
            sample = fh.read(SNIFF_BYTES)

        if self.config.get("delimiter"):
            dialect = csv.excel
            dialect_warnings: list[str] = []

            class _Forced(csv.excel):
                delimiter = str(self.config["delimiter"])

            dialect = _Forced
        else:
            dialect, dialect_warnings = detect_dialect(sample)
        warnings.extend(dialect_warnings)

        with self._open() as fh:
            reader = csv.reader(fh, dialect)
            rows: list[list[str]] = []
            for i, row in enumerate(reader):
                rows.append(row)
                if i >= HEADER_SCAN_LIMIT:
                    break

        if not rows:
            raise ValueError(f"{self.path.name} is empty.")

        forced = self.config.get("skip_rows")
        if forced is not None:
            header_index = int(forced)
        else:
            header_index = next(
                (i for i, row in enumerate(rows) if _looks_like_header(row)),
                0,
            )
            if header_index > 0:
                warnings.append(
                    f"Skipped {header_index} row(s) of preamble above the header."
                )

        if header_index >= len(rows):
            raise ValueError(
                f"skip_rows={header_index} is past the end of {self.path.name}."
            )

        columns, dupe_warnings = _dedupe(rows[header_index])
        warnings.extend(dupe_warnings)
        return columns, header_index, dialect, warnings

    # -- Connector ---------------------------------------------------------

    def discover(self) -> SourceInfo:
        columns, header_index, dialect, warnings = self._prepare()

        # Counted by scanning, because a quoted newline makes a line count
        # wrong and a wrong count shown to a user is worse than none.
        with self._open() as fh:
            reader = csv.reader(fh, dialect)
            total = sum(1 for _ in reader)
        row_count = max(0, total - header_index - 1)

        return SourceInfo(
            columns=columns,
            row_count=row_count,
            details={
                "path": str(self.path),
                "encoding": self._encoding,
                "delimiter": getattr(dialect, "delimiter", ","),
                "header_row": header_index + 1,
            },
            warnings=warnings,
        )

    def fetch(self, since: Any | None = None) -> Iterator[SourceRow]:
        # `since` is ignored: a file has no watermark, and pretending otherwise
        # would silently skip rows the user expected to import.
        columns, header_index, dialect, _ = self._prepare()
        id_column = self.config.get("id_column")

        with self._open() as fh:
            reader = csv.reader(fh, dialect)
            for _ in range(header_index + 1):
                next(reader, None)

            for offset, raw in enumerate(reader):
                # Row numbers are what the user sees in their spreadsheet, so
                # they count the preamble and the header and start at 1.
                row_number = header_index + 2 + offset

                if not any(cell.strip() for cell in raw):
                    continue  # blank separator line

                values = {
                    col: (raw[i].strip() if i < len(raw) else "")
                    for i, col in enumerate(columns)
                }
                # Cells beyond the header width are kept rather than dropped;
                # losing data silently is the one thing this must not do.
                if len(raw) > len(columns):
                    for extra_i in range(len(columns), len(raw)):
                        values[f"_extra_{extra_i}"] = raw[extra_i].strip()

                yield SourceRow(
                    row_number=row_number,
                    values=values,
                    external_id=(values.get(id_column) or None) if id_column else None,
                )

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None
