"""
Column mapping.

A column called "Summary", "Title" or "Task name" all mean the same thing, and
a construction export says "Trade" and "Inspection status" where a software one
says "Component" and "Status". The importer cannot know that, and the user
should not have to explain it twice.

So: propose a mapping from the header names, let the user correct it, and
persist the result on the data source. The next upload from the same place
needs no mapping step at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .csv_source import normalise_header

#: Canonical fields an import can write, with the aliases seen in the wild.
#:
#: Ordered most-specific first within each field: "external_id" must beat the
#: bare "id" of a different system, and "summary" must not win over "title"
#: when a file happens to have both.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "external_id": (
        "external_id", "issue_key", "key", "id", "ref", "reference",
        "number", "item", "item_no", "item_number", "code",
    ),
    "title": ("title", "summary", "name", "task", "task_name", "subject", "description_short"),
    "description": ("description", "details", "notes", "body", "comment"),
    "status": ("status", "state", "stage", "workflow_status", "progress", "phase_status"),
    "type": ("type", "issue_type", "work_type", "category", "kind", "discipline", "trade"),
    "priority": ("priority", "urgency", "importance"),
    "severity": ("severity", "impact", "risk_level"),
    "assignee": ("assignee", "owner", "responsible", "assigned_to", "allocated_to"),
    "reporter": ("reporter", "created_by", "raised_by", "requested_by", "author"),
    "estimate": ("estimate", "story_points", "points", "effort", "duration", "days", "hours"),
    "created_at": ("created", "created_at", "created_date", "raised", "date_raised", "opened"),
    "started_at": ("started", "started_at", "start_date", "in_progress_date", "commenced"),
    "completed_at": (
        "completed", "completed_at", "resolved", "resolved_at", "done_date",
        "closed", "closed_at", "finish_date", "actual_finish",
    ),
    "due_date": ("due", "due_date", "target_date", "deadline", "planned_finish"),
    "labels": ("labels", "tags", "keywords"),
    "milestone": ("milestone", "release", "fix_version", "phase", "work_package"),
    "iteration": ("iteration", "sprint", "cycle", "sprint_name"),
    "project": ("project", "project_key", "project_name", "job", "job_number"),
    "blocked_reason": ("blocked_reason", "blocker", "impediment", "on_hold_reason"),
}

#: Fields whose values become taxonomy terms rather than literal text. Unknown
#: values in these are reported rather than silently coerced, because a typo'd
#: status that quietly becomes a new term corrupts every flow metric.
TAXONOMY_FIELDS: dict[str, str] = {
    "status": "workflow_status",
    "type": "work_item_type",
    "priority": "priority",
    "severity": "severity",
}

#: The only fields an import genuinely cannot proceed without.
REQUIRED_FIELDS = ("title",)


@dataclass(slots=True)
class Mapping:
    """
    Source column -> canonical field.

    `columns` is the authoritative direction (one source column maps to at most
    one field). Unmapped columns are not an error; they are preserved verbatim
    in `work_items.metadata` so nothing is lost on a first pass.
    """

    columns: dict[str, str] = field(default_factory=dict)
    #: Columns deliberately ignored, so a re-proposal does not keep suggesting them.
    ignored: list[str] = field(default_factory=list)

    def field_for(self, column: str) -> str | None:
        return self.columns.get(column)

    def column_for(self, canonical: str) -> str | None:
        for col, fld in self.columns.items():
            if fld == canonical:
                return col
        return None

    def unmapped(self, all_columns: list[str]) -> list[str]:
        return [c for c in all_columns if c not in self.columns and c not in self.ignored]

    def missing_required(self) -> list[str]:
        mapped = set(self.columns.values())
        return [f for f in REQUIRED_FIELDS if f not in mapped]

    def to_config(self) -> dict[str, Any]:
        return {"columns": dict(self.columns), "ignored": list(self.ignored)}

    @classmethod
    def from_config(cls, config: dict[str, Any] | None) -> Mapping:
        if not config:
            return cls()
        raw = config.get("mapping") or config
        return cls(
            columns=dict(raw.get("columns") or {}),
            ignored=list(raw.get("ignored") or []),
        )


def propose(columns: list[str]) -> Mapping:
    """
    Guesses a mapping from header names.

    Exact alias matches first, across every field, before any fuzzy matching.
    Doing it in two passes matters: a one-pass loop lets a loose substring hit
    on an early field steal a column that a later field matches exactly.

    Each source column is claimed at most once, and each canonical field is
    filled at most once -- a duplicate guess is left for the user rather than
    picked arbitrarily.
    """
    mapping = Mapping()
    normalised = {col: normalise_header(col) for col in columns}
    claimed_fields: set[str] = set()

    # Pass 1: exact alias match.
    for canonical, aliases in FIELD_ALIASES.items():
        for col, norm in normalised.items():
            if col in mapping.columns or canonical in claimed_fields:
                continue
            if norm in aliases:
                mapping.columns[col] = canonical
                claimed_fields.add(canonical)
                break

    # Pass 2: substring, only for fields still unfilled. Requires the alias to
    # be a whole token in the column name, so "due" does not match "overdue".
    for canonical, aliases in FIELD_ALIASES.items():
        if canonical in claimed_fields:
            continue
        for col, norm in normalised.items():
            if col in mapping.columns:
                continue
            tokens = set(norm.split("_"))
            if any(alias in tokens for alias in aliases):
                mapping.columns[col] = canonical
                claimed_fields.add(canonical)
                break

    # Last resort for title, which is the one field an import cannot proceed
    # without. Plenty of schedules have no "title" column at all -- an interior
    # designer's order list has "Description" and nothing else -- and blocking
    # the whole import over a naming convention is unhelpful when the intended
    # column is obvious. The text becomes the title rather than the
    # description, which is the same text in the place the UI actually shows.
    if "title" not in claimed_fields:
        for col, fld in list(mapping.columns.items()):
            if fld == "description":
                mapping.columns[col] = "title"
                claimed_fields.discard("description")
                claimed_fields.add("title")
                break

    return mapping


@dataclass(slots=True)
class MappingReport:
    """What a proposed mapping would and would not do, for review before import."""

    mapping: Mapping
    unmapped: list[str]
    missing_required: list[str]
    taxonomy_fields: list[str]

    @property
    def ok(self) -> bool:
        return not self.missing_required

    def describe(self) -> str:
        lines = ["Column mapping:"]
        for col, fld in sorted(self.mapping.columns.items(), key=lambda kv: kv[1]):
            marker = "  *" if fld in TAXONOMY_FIELDS else "   "
            lines.append(f"{marker} {col:<28} -> {fld}")
        if self.taxonomy_fields:
            lines.append("")
            lines.append("  * resolved against the taxonomy; unknown values are reported")
        if self.unmapped:
            lines.append("")
            lines.append(f"Unmapped ({len(self.unmapped)}), kept verbatim in metadata:")
            lines.append("    " + ", ".join(self.unmapped))
        if self.missing_required:
            lines.append("")
            lines.append("MISSING required: " + ", ".join(self.missing_required))
        return "\n".join(lines)


def report(columns: list[str], mapping: Mapping) -> MappingReport:
    return MappingReport(
        mapping=mapping,
        unmapped=mapping.unmapped(columns),
        missing_required=mapping.missing_required(),
        taxonomy_fields=sorted(
            {f for f in mapping.columns.values() if f in TAXONOMY_FIELDS}
        ),
    )
