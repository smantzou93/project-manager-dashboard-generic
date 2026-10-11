"""
Structured logging, in the shared format.

One line-delimited JSON object per event, with the same field names the other
tiers use, so `jq 'select(.correlation_id=="...")' logs/*.log` reconstructs a
whole operation across web, api, db and ingestion. (Groundwork for M5; the
format is fixed here so the Python side does not have to be revisited.)

Secrets are redacted at the serialiser rather than at each call site. Doing it
per call site means it works until somebody forgets, and this repository is
public while the logs are not.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOG_DIR = Path(os.environ.get("PMD_LOG_DIR", "logs"))

#: Anything whose key looks like one of these is replaced, at any depth.
SECRET_KEYS = re.compile(
    r"(password|secret|token|api[_-]?key|credential|authorization|database_url)",
    re.IGNORECASE,
)
#: A connection string that slipped into a message rather than a field.
DSN = re.compile(r"(postgres(?:ql)?://[^:]+:)[^@]+(@)", re.IGNORECASE)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: ("[redacted]" if SECRET_KEYS.search(str(k)) else _redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        return DSN.sub(r"\1[redacted]\2", value)
    return value


class Logger:
    """Emits to stdout and to logs/ingestion.log, both in the shared schema."""

    def __init__(self, correlation_id: str | None = None) -> None:
        self.correlation_id = correlation_id or uuid.uuid4().hex[:16]
        self.tier = "ingestion"
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            self._file = (LOG_DIR / "ingestion.log").open("a", encoding="utf-8")
        except OSError:
            # A read-only filesystem must not stop an import; stdout is enough.
            self._file = None

    def event(self, event: str, level: str = "info", **ctx: Any) -> None:
        record = {
            "ts": datetime.now(UTC).isoformat(),
            "level": level,
            "tier": self.tier,
            "event": event,
            "correlation_id": self.correlation_id,
            **{k: v for k, v in _redact(ctx).items() if v is not None},
        }
        line = json.dumps(record, default=str)
        if self._file:
            self._file.write(line + "\n")
            self._file.flush()
        # Human-readable on a terminal, machine-readable when piped.
        if sys.stderr.isatty() and not os.environ.get("PMD_JSON_LOGS"):
            print(f"  {event} {_brief(record)}", file=sys.stderr)
        else:
            print(line, file=sys.stderr)

    def close(self) -> None:
        if self._file:
            self._file.close()
            self._file = None


def _brief(record: dict[str, Any]) -> str:
    skip = {"ts", "level", "tier", "event", "correlation_id"}
    return " ".join(f"{k}={v}" for k, v in record.items() if k not in skip)


class Timer:
    """Measures a block and reports duration_ms on the given event."""

    def __init__(self, log: Logger, event: str, **ctx: Any) -> None:
        self.log, self.event, self.ctx = log, event, ctx

    def __enter__(self) -> Timer:
        self._t0 = time.monotonic()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        ms = int((time.monotonic() - self._t0) * 1000)
        if exc is None:
            self.log.event(self.event, duration_ms=ms, **self.ctx)
        else:
            self.log.event(
                self.event, level="error", duration_ms=ms, error=str(exc), **self.ctx
            )
