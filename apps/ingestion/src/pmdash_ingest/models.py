"""
Row validation.

The contract: a bad row never aborts an import and never disappears. It goes
to `ingestion_rejects` with its row number, the raw values the user actually
wrote, and a reason they can act on -- then the run continues.

Only a structural failure (unreadable file, no header) stops everything,
because at that point there is nothing to continue with.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, date, datetime
from typing import Any

from dateutil import parser as date_parser
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

#: Values that mean "nothing here". Exports use all of these, and treating
#: "N/A" as a literal title is worse than treating it as empty.
EMPTY = {"", "-", "--", "n/a", "na", "none", "null", "nil", "tbd", "tbc", "#n/a"}


def is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip().casefold() in EMPTY)


def clean(value: Any) -> str | None:
    if is_empty(value):
        return None
    return str(value).strip()


def parse_date(value: Any, *, field_name: str) -> datetime | None:
    """
    Parses a date the way a spreadsheet wrote it.

    `dayfirst=True` because this project's presets and users are not US-centric
    and 03/04/2026 is far more often 3 April than 4 March here. It is the kind
    of default that is wrong either way for somebody, so it is stated plainly
    rather than left to the library.

    Naive values are assumed UTC. Everything downstream compares against
    `asOf`, and mixing naive and aware datetimes raises at comparison time --
    a long way from the row that caused it.
    """
    text = clean(value)
    if text is None:
        return None

    # A bare year would parse as a date in the current month, which is a
    # confident wrong answer rather than a useful one.
    if re.fullmatch(r"\d{4}", text):
        raise ValueError(f'{field_name}: "{text}" is a year, not a date')

    try:
        parsed = date_parser.parse(text, dayfirst=True)
    except (ValueError, OverflowError) as exc:
        raise ValueError(f'{field_name}: cannot parse "{text}" as a date') from exc

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def parse_number(value: Any, *, field_name: str) -> float | None:
    """Parses an estimate, tolerating thousands separators and a stray unit."""
    text = clean(value)
    if text is None:
        return None
    stripped = re.sub(r"[^\d.\-]", "", text.replace(",", ""))
    if stripped in ("", "-", "."):
        raise ValueError(f'{field_name}: "{text}" is not a number')
    try:
        return float(stripped)
    except ValueError as exc:
        raise ValueError(f'{field_name}: "{text}" is not a number') from exc


def parse_labels(value: Any) -> list[str]:
    text = clean(value)
    if text is None:
        return []
    return [p.strip() for p in re.split(r"[,;|]", text) if p.strip()]


def derive_external_id(source_name: str, values: dict[str, str], row_number: int) -> str:
    """
    A stable key for a source that supplies none.

    Hashed from the row's own content, not its position, so re-uploading a file
    with rows inserted above does not re-key -- and therefore does not
    duplicate -- everything below. Position is only a last resort for a row
    whose content is entirely empty.

    Documented here because the upsert contract depends on it: the same logical
    row must hash the same way on every import.
    """
    material = "\u001f".join(
        f"{k}={v}" for k, v in sorted(values.items()) if v and not k.startswith("_extra_")
    )
    if not material:
        material = f"__row__{row_number}"
    digest = hashlib.sha256(f"{source_name}\u001f{material}".encode()).hexdigest()
    return f"csv-{digest[:24]}"


class WorkItemRow(BaseModel):
    """
    A validated row, ready to upsert.

    `model_config` forbids extra fields so a typo in the mapping surfaces here
    rather than silently writing nothing.
    """

    model_config = ConfigDict(extra="forbid")

    external_id: str
    title: str = Field(min_length=1)
    description: str | None = None

    status: str | None = None
    type: str | None = None
    priority: str | None = None
    severity: str | None = None

    assignee: str | None = None
    reporter: str | None = None
    estimate: float | None = None

    source_created_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    due_date: date | None = None

    labels: list[str] = Field(default_factory=list)
    milestone: str | None = None
    iteration: str | None = None
    project: str | None = None
    blocked_reason: str | None = None

    #: Every column the mapping did not claim, kept verbatim. Nothing is lost
    #: on a first pass, and a user can see what they still need to map.
    metadata: dict[str, str] = Field(default_factory=dict)

    @field_validator("title")
    @classmethod
    def _title_not_placeholder(cls, v: str) -> str:
        if is_empty(v):
            raise ValueError("title is empty")
        return v.strip()

    def check_timeline(self) -> None:
        """
        Rejects a row whose own dates contradict each other.

        Accepting these would put the contradiction into the database, where it
        surfaces later as a negative cycle time on a chart with no clue which
        import caused it. The schema's integrity checks assert exactly this, so
        catching it at the door keeps them meaningful.
        """
        c, s, d = self.source_created_at, self.started_at, self.completed_at
        if c and s and s < c:
            raise ValueError(f"started ({s:%Y-%m-%d}) is before created ({c:%Y-%m-%d})")
        if s and d and d < s:
            raise ValueError(f"completed ({d:%Y-%m-%d}) is before started ({s:%Y-%m-%d})")
        if c and d and d < c:
            raise ValueError(f"completed ({d:%Y-%m-%d}) is before created ({c:%Y-%m-%d})")


def build_row(
    *,
    values: dict[str, str],
    mapping_columns: dict[str, str],
    row_number: int,
    source_name: str,
    external_id: str | None = None,
) -> WorkItemRow:
    """
    Turns raw cells into a validated row, or raises with a readable reason.

    Raises ValueError with a message meant for a human reading a reject
    ledger -- naming the column and the value, not a pydantic traceback.
    """
    fields: dict[str, Any] = {}
    metadata: dict[str, str] = {}

    for column, raw in values.items():
        canonical = mapping_columns.get(column)
        if canonical is None:
            cleaned = clean(raw)
            if cleaned is not None:
                metadata[column] = cleaned
            continue

        if canonical in ("created_at", "started_at", "completed_at"):
            target = "source_created_at" if canonical == "created_at" else canonical
            fields[target] = parse_date(raw, field_name=column)
        elif canonical == "due_date":
            parsed = parse_date(raw, field_name=column)
            fields["due_date"] = parsed.date() if parsed else None
        elif canonical == "estimate":
            fields["estimate"] = parse_number(raw, field_name=column)
        elif canonical == "labels":
            fields["labels"] = parse_labels(raw)
        else:
            fields[canonical] = clean(raw)

    if not fields.get("external_id"):
        fields["external_id"] = external_id or derive_external_id(
            source_name, values, row_number
        )

    fields["metadata"] = metadata

    # Checked before pydantic so the ledger says "title is empty (column
    # \"Task name\")" rather than "Input should be a valid string". A reject
    # reason is read by whoever has to fix the spreadsheet, not by a developer.
    if not fields.get("title"):
        column = next((c for c, f in mapping_columns.items() if f == "title"), "title")
        raise ValueError(f'title is empty (column "{column}")')

    try:
        row = WorkItemRow(**fields)
    except ValidationError as exc:
        raise ValueError(_readable(exc)) from exc

    row.check_timeline()
    return row


def _readable(exc: ValidationError) -> str:
    """Turns a pydantic error into one line a non-Python user can act on."""
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "row"
        parts.append(f"{loc}: {err['msg']}")
    return "; ".join(parts)
