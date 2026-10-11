#!/usr/bin/env bash
# db-reset.sh -- return the database to a known-good state.
#
#   ./scripts/db-reset.sh                    rebuild schema, migrate, seed
#   ./scripts/db-reset.sh --preset construction
#   ./scripts/db-reset.sh --volume           also destroy the Docker volume
#   ./scripts/db-reset.sh --no-seed          schema only, no demo data
#
# Why this script exists rather than a one-liner:
#
# Drizzle records applied migrations in a separate `drizzle` schema, outside
# `public`. Running `DROP SCHEMA public CASCADE` by hand therefore deletes every
# table while LEAVING that ledger intact -- after which `db:migrate` reports
# "migrations applied" in a few milliseconds and creates nothing, because it
# believes the work is already done. The database ends up empty and the tooling
# insists it is current. Dropping both schemas together is the fix.

set -euo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PRESET=""
DROP_VOLUME=0
RUN_SEED=1

while [ $# -gt 0 ]; do
  case "$1" in
    --preset)  PRESET="${2:?--preset needs a name}"; shift ;;
    --volume)  DROP_VOLUME=1 ;;
    --no-seed) RUN_SEED=0 ;;
    --yes|-y)  PMD_ASSUME_YES=1; export PMD_ASSUME_YES ;;
    --help|-h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

cd "$PMD_ROOT"
load_env

info "This destroys all local data in the '${POSTGRES_DB:-pmdash}' database."
confirm "Continue?" default_yes || { say "Aborted."; exit 0; }

start_container_runtime || die "Need a running Docker daemon."

if [ "$DROP_VOLUME" -eq 1 ]; then
  info "Removing the container and its volume..."
  docker compose down -v
  info "Starting a fresh database..."
  docker compose up -d db
else
  docker compose up -d db >/dev/null
fi

# Wait for the healthcheck rather than a fixed sleep; initdb timing varies.
info "Waiting for Postgres to report healthy..."
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' pmdash-db 2>/dev/null || echo missing)"
  [ "$state" = healthy ] && break
  sleep 2
done
[ "${state:-}" = healthy ] || die "Postgres did not become healthy. Try: docker compose logs db"
ok "Postgres is healthy."

if [ "$DROP_VOLUME" -eq 0 ]; then
  # Both schemas, together -- see the header comment for why.
  info "Dropping the public and drizzle schemas..."
  docker exec pmdash-db psql -U "${POSTGRES_USER:-pmdash}" -d "${POSTGRES_DB:-pmdash}" -q \
    -c 'drop schema if exists public cascade;' \
    -c 'drop schema if exists drizzle cascade;' \
    -c 'create schema public;' >/dev/null
  ok "Schemas dropped."
fi

info "Applying migrations..."
npm run --silent db:migrate

# A migration run that creates nothing on an empty database means the ledger and
# the schema have drifted apart -- fail loudly instead of handing back a database
# that looks fine until the first query.
table_count="$(docker exec pmdash-db psql -U "${POSTGRES_USER:-pmdash}" -d "${POSTGRES_DB:-pmdash}" -t -A \
  -c "select count(*) from information_schema.tables where table_schema='public';" | tr -d '[:space:]')"
if [ "${table_count:-0}" -lt 2 ]; then
  die "Migrations reported success but public has only ${table_count} table(s). The drizzle ledger is out of sync -- re-run with --volume."
fi
ok "Schema has ${table_count} tables."

if [ "$RUN_SEED" -eq 1 ]; then
  info "Seeding demo data${PRESET:+ (preset: $PRESET)}..."
  if [ -n "$PRESET" ]; then
    npm run --silent db:seed -- "$PRESET"
  else
    npm run --silent db:seed
  fi
fi

hr
ok "Database reset complete."
