from __future__ import annotations

import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _load_root_env() -> None:
    """Loads the repository-root .env, the same file every other tier uses."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_root_env()


@pytest.fixture(scope="session")
def db_available() -> bool:
    try:
        import psycopg

        from pmdash_ingest.db import database_url

        with psycopg.connect(database_url(), connect_timeout=3) as conn:
            conn.execute("select 1")
        return True
    except Exception:
        return False


@pytest.fixture(autouse=True)
def _skip_db_tests(request, db_available):
    if request.node.get_closest_marker("db") and not db_available:
        pytest.skip("needs a running database: ./scripts/dev.sh --seed-only")
