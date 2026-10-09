"""
Command line entry point.

    pmdash-ingest inspect   file.csv
    pmdash-ingest dry-run   file.csv --project RIVER
    pmdash-ingest import    file.csv --project RIVER

`import` is the only subcommand that writes, and it still runs the dry-run
analysis first and refuses on a bad mapping. Writing to someone's database is
tedious to undo.
"""

from __future__ import annotations

import argparse
import json
import sys

from .connector import get_connector
from .csv_source import CsvConnector  # noqa: F401  -- registers "csv"
from .logs import Logger
from .mapping import Mapping, propose, report
from .pipeline import DEFAULT_MAX_REJECT_RATIO, run_import


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pmdash-ingest",
        description="Import work items from a CSV into the dashboard.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    for name, help_text in (
        (
            "inspect",
            "Report the file's shape and the proposed mapping. Writes nothing.",
        ),
        ("dry-run", "Run the full import inside a transaction that is rolled back."),
        ("import", "Run the import for real."),
    ):
        sp = sub.add_parser(name, help=help_text)
        sp.add_argument("path", help="CSV file to read")
        sp.add_argument("--source", help="Name for this data source (default: the file name)")
        sp.add_argument("--project", help="Project key for rows that do not name one")
        sp.add_argument("--delimiter", help="Override the sniffed delimiter")
        sp.add_argument("--encoding", help="Override the detected encoding")
        sp.add_argument("--skip-rows", type=int, help="Rows of preamble above the header")
        sp.add_argument("--id-column", help="Column holding a stable identifier")
        sp.add_argument(
            "--map",
            action="append",
            metavar="COLUMN=field",
            help="Override one column's mapping. Repeatable.",
        )
        sp.add_argument(
            "--max-reject-ratio",
            type=float,
            default=DEFAULT_MAX_REJECT_RATIO,
            help=f"Fail above this share of rejected rows (default {DEFAULT_MAX_REJECT_RATIO})",
        )
        sp.add_argument("--json", action="store_true", help="Machine-readable output")

    return p


def _config(args: argparse.Namespace) -> dict:
    cfg: dict = {"path": args.path}
    for key in ("delimiter", "encoding", "id_column"):
        value = getattr(args, key, None)
        if value:
            cfg[key] = value
    if getattr(args, "skip_rows", None) is not None:
        cfg["skip_rows"] = args.skip_rows
    return cfg


def _overrides(args: argparse.Namespace, base: Mapping) -> Mapping:
    for pair in getattr(args, "map", None) or []:
        if "=" not in pair:
            raise SystemExit(f'--map expects COLUMN=field, got "{pair}"')
        column, field_name = pair.split("=", 1)
        if field_name.strip() in ("", "-", "ignore"):
            base.columns.pop(column.strip(), None)
            base.ignored.append(column.strip())
        else:
            base.columns[column.strip()] = field_name.strip()
    return base


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    source_name = args.source or args.path.rsplit("/", 1)[-1]
    log = Logger()

    connector = get_connector("csv", _config(args))

    if args.command == "inspect":
        info = connector.discover()
        mapping = _overrides(args, propose(info.columns))
        rep = report(info.columns, mapping)
        if args.json:
            print(json.dumps({
                "columns": info.columns,
                "rows": info.row_count,
                "details": info.details,
                "warnings": info.warnings,
                "mapping": mapping.to_config(),
                "missing_required": rep.missing_required,
            }, indent=2, default=str))
        else:
            print(f"{args.path}: {info.row_count} rows, {len(info.columns)} columns")
            for k, v in info.details.items():
                if k != "path":
                    print(f"  {k}: {v}")
            for w in info.warnings:
                print(f"  warning: {w}")
            print()
            print(rep.describe())
        return 0 if rep.ok else 2

    dry = args.command == "dry-run"
    info = connector.discover()
    mapping = _overrides(args, Mapping())
    if not mapping.columns:
        mapping = _overrides(args, propose(info.columns))

    outcome = run_import(
        connector=connector,
        source_name=source_name,
        dry_run=dry,
        mapping=mapping,
        project_key=args.project,
        max_reject_ratio=args.max_reject_ratio,
        log=log,
    )

    if args.json:
        print(json.dumps({
            "run_id": outcome.run_id,
            "correlation_id": outcome.correlation_id,
            "dry_run": outcome.dry_run,
            "rows_read": outcome.rows_read,
            "inserted": outcome.inserted,
            "updated": outcome.updated,
            "unchanged": outcome.unchanged,
            "rejected": outcome.rejected,
            "transitions": outcome.transitions,
            "unknown_terms": outcome.unknown_terms,
            "aborted": outcome.aborted,
        }, indent=2, default=str))
    else:
        print()
        print(outcome.summary())
        if dry:
            print()
            print("Nothing was written. Re-run with `import` to commit.")

    log.close()
    if outcome.aborted:
        print(f"\nFAILED: {outcome.aborted}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
