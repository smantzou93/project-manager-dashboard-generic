#!/usr/bin/env bash
# dev.sh -- bring the whole stack up, in order, and keep it up.
#
#   ./scripts/dev.sh                      start everything, seed if empty
#   ./scripts/dev.sh --preset construction
#   ./scripts/dev.sh --pinned             seed at the fixed test instant
#   ./scripts/dev.sh --seed-only          prepare the database, then exit
#   ./scripts/dev.sh --no-seed            never seed, even if empty
#
# The tiers have a strict order -- runtime, database, migrations, data, web --
# and each step fails for a different reason with a different fix. Running them
# by hand means discovering that in the wrong order, usually as a Next.js stack
# trace about a missing table. So this script checks each one and says what to
# do next.
#
# Safe to re-run. Nothing here destroys data; use db-reset.sh for that.

set -euo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PRESET="${PMDASH_PRESET:-}"
PINNED=0
SEED_ONLY=0
ALLOW_SEED=1

# Keep in step with tests/fixtures.ts -- the visual suite asserts this instant.
PINNED_CLOCK="2026-10-01T12:00:00Z"

while [ $# -gt 0 ]; do
  case "$1" in
    --preset)    PRESET="${2:?--preset needs a name}"; shift ;;
    --pinned)    PINNED=1 ;;
    --seed-only) SEED_ONLY=1 ;;
    --no-seed)   ALLOW_SEED=0 ;;
    --yes|-y)    PMD_ASSUME_YES=1; export PMD_ASSUME_YES ;;
    --help|-h)   sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

cd "$PMD_ROOT"

# --- 1. environment --------------------------------------------------------
if [ ! -f .env ]; then
  warn "No .env found."
  say "  Generating one now via preflight (it also checks your tooling)."
  ./scripts/preflight.sh --yes
fi
load_env

[ -n "${DATABASE_URL:-}" ] || die ".env exists but DATABASE_URL is unset. Delete .env and re-run ./scripts/preflight.sh."

# --- 2. node modules -------------------------------------------------------
# Compare against the lockfile rather than just testing for the directory: a
# stale node_modules after a dependency change fails in confusing ways.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  info "Installing dependencies..."
  npm install
fi

# --- 3. container runtime --------------------------------------------------
start_container_runtime || die "Need a running Docker daemon; Postgres runs in a container."
link_compose_plugin >/dev/null 2>&1 || true
COMPOSE="$(compose_cmd)" || die "Neither 'docker compose' nor 'docker-compose' works."

# --- 4. database -----------------------------------------------------------
info "Starting Postgres..."
$COMPOSE up -d db >/dev/null

info "Waiting for Postgres to report healthy..."
state=missing
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' pmdash-db 2>/dev/null || echo missing)"
  [ "$state" = healthy ] && break
  sleep 2
done
if [ "$state" != healthy ]; then
  err "Postgres did not become healthy."
  say "  Logs:  $COMPOSE logs db"
  say "  If it is complaining about authentication, .env was probably"
  say "  regenerated after the volume was created. Postgres only reads"
  say "  POSTGRES_PASSWORD at initdb, so the volume still wants the old one:"
  say "      ./scripts/db-reset.sh --yes --volume"
  exit 1
fi
ok "Postgres is healthy."

psql_q() {
  docker exec -i pmdash-db psql -U "${POSTGRES_USER:-pmdash}" -d "${POSTGRES_DB:-pmdash}" -t -A -c "$1" \
    2>/dev/null | tr -d '[:space:]'
}

# --- 5. migrations ---------------------------------------------------------
info "Applying migrations..."
npm run --silent db:migrate

tables="$(psql_q "select count(*) from information_schema.tables where table_schema='public';")"
if [ "${tables:-0}" -lt 2 ]; then
  err "Migrations reported success but public has only ${tables:-0} table(s)."
  say "  Drizzle's ledger lives in the 'drizzle' schema, outside public, so a"
  say "  hand-dropped public schema leaves it believing the work is done."
  say "      ./scripts/db-reset.sh --yes --volume"
  exit 1
fi
ok "Schema has ${tables} tables."

# --- 6. data ---------------------------------------------------------------
items="$(psql_q "select count(*) from work_items;")"
seed_now=""
[ "$PINNED" -eq 1 ] && seed_now="$PINNED_CLOCK"

run_seed() {
  info "Seeding${PRESET:+ (preset: $PRESET)}${seed_now:+ at pinned clock $seed_now}..."
  if [ -n "$seed_now" ]; then
    PMDASH_SEED_NOW="$seed_now" npm run --silent db:seed ${PRESET:+-- "$PRESET"}
  else
    npm run --silent db:seed ${PRESET:+-- "$PRESET"}
  fi
}

if [ "$PINNED" -eq 1 ] || [ -n "$PRESET" ]; then
  # An explicit preset or a pinned clock is a request for specific data, so
  # reseed even when rows exist -- otherwise --pinned would silently leave a
  # live-clock fixture in place and the visual suite would fail far from here.
  if [ "$ALLOW_SEED" -eq 1 ]; then
    run_seed
  else
    warn "--no-seed given, so the existing data is left as-is."
  fi
elif [ "${items:-0}" -eq 0 ]; then
  if [ "$ALLOW_SEED" -eq 1 ]; then
    say "The database is empty."
    run_seed
  else
    warn "Database is empty and --no-seed was given; the dashboard will render empty states."
  fi
else
  ok "Database already has ${items} work items."
fi

if [ "$SEED_ONLY" -eq 1 ]; then
  hr
  ok "Database ready. Skipping the web server (--seed-only)."
  exit 0
fi

# --- 7. web ----------------------------------------------------------------
if [ ! -f apps/web/package.json ]; then
  hr
  warn "apps/web does not exist yet, so there is nothing to serve."
  say "  The database is ready. Tracking issue: #24 (app shell)."
  exit 0
fi

mkdir -p "$PMD_LOG_DIR"
hr
ok "Stack is up. Starting Next.js on http://localhost:${PORT:-3000}"
dim "    logs: $PMD_LOG_DIR"
hr

# exec so Ctrl-C reaches Next.js directly instead of being trapped by this
# script, which would otherwise leave the dev server orphaned.
exec npm run --workspace @pmdash/web dev
