"""
The connector contract.

CSV is the only implementation today, deliberately. The point of defining the
seam now is that the next source -- Jira, Linear, GitHub, a spreadsheet export
from a contractor -- is an additive change rather than a rewrite of the
pipeline around it.

A connector's job is narrow: produce rows, and say what it knows about them.
Everything downstream -- validation, taxonomy resolution, upserting, transition
synthesis, the reject ledger, run bookkeeping -- is shared and lives in
`pipeline.py`. A connector that reimplements any of that is doing too much.

**Credentials never live in a connector's config.** `data_sources.config` is
stored in a database that gets backed up, and this repository is public. A
connector that needs a token declares the *name* of the environment variable
holding it (`token_env: "JIRA_API_TOKEN"`) and resolves it at run time.
`resolve_secret` below is the only sanctioned way to read one.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class SourceRow:
    """
    One record as the source presented it, before any interpretation.

    `values` keys are the source's own column names, normalised only for
    lookup. Nothing is coerced here: a connector reports what it read, and the
    pipeline decides what it means. Keeping those separate is what lets a
    rejected row be shown back to the user as the thing they actually wrote.
    """

    row_number: int
    values: dict[str, str]
    #: Set when the source itself supplies a stable identifier.
    external_id: str | None = None


@dataclass(slots=True)
class SourceInfo:
    """What a connector discovered about a source before reading it."""

    #: Column names in the order the source presents them.
    columns: list[str]
    #: Rows available, when the source can say cheaply. None when it cannot.
    row_count: int | None = None
    #: Anything worth showing the user: detected encoding, dialect, sheet name.
    details: dict[str, Any] = field(default_factory=dict)
    #: Non-fatal observations: a duplicate header, a skipped preamble.
    warnings: list[str] = field(default_factory=list)


class Connector(ABC):
    """
    Base class for every data source.

    Implementations are constructed with their `data_sources.config` dict and
    must be usable without network or credentials until `fetch` is called, so
    that `discover` stays cheap enough to drive a mapping UI.
    """

    #: Matches the `source_kind` enum in the database schema.
    kind: str

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    @abstractmethod
    def discover(self) -> SourceInfo:
        """
        Inspect the source and report its shape without importing anything.

        Drives the mapping step: the user sees real column names and a row
        count before committing to anything.
        """

    @abstractmethod
    def fetch(self, since: Any | None = None) -> Iterator[SourceRow]:
        """
        Yield rows, streaming.

        An iterator rather than a list on purpose. A 200k-row export should not
        need 200k rows of memory, and the reject ledger means a bad row part
        way through must not discard the work already done.

        `since` is an incremental watermark for sources that support one. CSV
        ignores it: a file is always read whole.
        """

    def close(self) -> None:  # noqa: B027  -- optional hook, deliberately not abstract
        """
        Release anything held open. Safe to call more than once.

        Not abstract on purpose: most connectors have nothing to close, and
        forcing every one to write an empty override is noise.
        """


def resolve_secret(config: dict[str, Any], key: str) -> str | None:
    """
    Reads a credential from the environment variable *named* in the config.

    `config["token_env"] = "JIRA_API_TOKEN"` resolves to the value of
    `$JIRA_API_TOKEN`. The secret itself is never written to `config`, because
    that column is backed up and this repository is public.

    Raises if the config names a variable that is not set, rather than silently
    attempting an unauthenticated request that fails later with a confusing
    error.
    """
    env_name = config.get(key)
    if not env_name:
        return None
    if not isinstance(env_name, str):
        raise TypeError(f"{key} must be the NAME of an environment variable, not a value")

    value = os.environ.get(env_name)
    if value is None:
        raise RuntimeError(
            f'{key} names the environment variable "{env_name}", which is not set. '
            f"Export it before running, or remove {key} from the source config."
        )
    return value


#: Populated by each implementation module at import time.
REGISTRY: dict[str, type[Connector]] = {}


def register(cls: type[Connector]) -> type[Connector]:
    """Class decorator making a connector resolvable by its `kind`."""
    REGISTRY[cls.kind] = cls
    return cls


def get_connector(kind: str, config: dict[str, Any]) -> Connector:
    if kind not in REGISTRY:
        known = ", ".join(sorted(REGISTRY)) or "none"
        raise ValueError(f'No connector registered for kind "{kind}". Available: {known}')
    return REGISTRY[kind](config)
