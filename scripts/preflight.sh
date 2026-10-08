#!/usr/bin/env bash
# preflight.sh -- inventory everything needed to RUN and EDIT this project,
# install what's missing, and start the container runtime.
#
# Safe to run repeatedly; it changes nothing that's already correct.
#
#   ./scripts/preflight.sh              interactive, prompts before installing
#   ./scripts/preflight.sh --yes        unattended, accepts every default
#   ./scripts/preflight.sh --check      report only, never install or start
#
# Exit status: 0 when the project can run, 1 when a hard requirement is absent.

set -uo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# --- Minimum versions --------------------------------------------------------
# Node 20 is the floor for Next.js 15. Python 3.11 is where tomllib and the
# modern typing syntax the ingestion code uses landed.
MIN_NODE=20.0.0
MIN_NPM=10.0.0
MIN_PYTHON=3.11.0
MIN_DOCKER=24.0.0
MIN_GIT=2.30.0

CHECK_ONLY=0
MISSING_HARD=0
MISSING_SOFT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)   PMD_ASSUME_YES=1; export PMD_ASSUME_YES ;;
    --check|-n) CHECK_ONLY=1 ;;
    --help|-h)  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

row() { printf '  %-14s %-12s %s\n' "$1" "$2" "$3"; }

# check_tool <label> <binary> <min> <hard|soft> <brew-formula> [version-cmd...]
check_tool() {
  local label="$1" bin="$2" min="$3" tier="$4" formula="$5"; shift 5
  local vcmd=("$@"); [ ${#vcmd[@]} -eq 0 ] && vcmd=("$bin" --version)
  local ver

  if ! have "$bin"; then
    row "$label" "-" "${C_RED}missing${C_RESET} (need >= $min)"
    if [ "$tier" = hard ]; then MISSING_HARD=$((MISSING_HARD + 1)); else MISSING_SOFT=$((MISSING_SOFT + 1)); fi
    [ "$CHECK_ONLY" -eq 0 ] && [ -n "$formula" ] && PMD_TO_INSTALL="${PMD_TO_INSTALL:-} $formula"
    return 1
  fi

  ver="$(version_of "${vcmd[@]}")"
  if version_gte "$ver" "$min"; then
    row "$label" "$ver" "${C_GRN}ok${C_RESET}"
    return 0
  fi
  row "$label" "${ver:-?}" "${C_YEL}too old${C_RESET} (need >= $min)"
  if [ "$tier" = hard ]; then MISSING_HARD=$((MISSING_HARD + 1)); else MISSING_SOFT=$((MISSING_SOFT + 1)); fi
  return 1
}

hr
say "${C_BOLD}Project Manager Dashboard - preflight${C_RESET}"
dim "$(uname -sr) / $(uname -m)   root: $PMD_ROOT"
hr

# --- Runtime requirements ----------------------------------------------------
info "Required to run the app"
check_tool "node"   node    "$MIN_NODE"   hard ""       node --version
check_tool "npm"    npm     "$MIN_NPM"    hard ""       npm --version
check_tool "python3" python3 "$MIN_PYTHON" hard python   python3 --version
check_tool "docker" docker  "$MIN_DOCKER" hard docker   docker --version
say ""

# --- Developer tooling -------------------------------------------------------
# Not needed to boot the stack, but needed to work on it or file issues.
info "Required to edit the project"
check_tool "git"    git     "$MIN_GIT"    hard git      git --version
check_tool "gh"     gh      2.0.0         soft gh       gh --version
say ""

# Node arrives via nvm/fnm/brew/Volta, each with its own upgrade path, so point
# at the right one instead of guessing a formula.
if ! have node; then
  warn "Node is missing. Install it with whichever manager you use:"
  say  "    nvm:    nvm install --lts && nvm alias default lts/*"
  say  "    brew:   brew install node"
  say  "    fnm:    fnm install --lts"
fi

# --- Container runtime -------------------------------------------------------
info "Container runtime (Postgres runs in Docker)"
RUNTIME="$(detect_container_runtime)"
row "runtime" "$RUNTIME" "$([ "$RUNTIME" = none ] && printf '%smissing%s' "$C_RED" "$C_RESET" || printf 'detected')"

if [ "$CHECK_ONLY" -eq 0 ]; then
  link_compose_plugin >/dev/null 2>&1 || true
fi
if COMPOSE="$(compose_cmd)"; then
  row "compose" "$(version_of $COMPOSE version)" "${C_GRN}ok${C_RESET} ($COMPOSE)"
else
  row "compose" "-" "${C_RED}missing${C_RESET}"
  MISSING_HARD=$((MISSING_HARD + 1))
  [ "$CHECK_ONLY" -eq 0 ] && PMD_TO_INSTALL="${PMD_TO_INSTALL:-} docker-compose"
fi

if docker_daemon_up; then
  row "daemon" "up" "${C_GRN}ok${C_RESET}"
else
  row "daemon" "down" "${C_YEL}not running${C_RESET}"
fi
say ""

# --- Install what's missing --------------------------------------------------
if [ "$CHECK_ONLY" -eq 1 ]; then
  hr
  [ "$MISSING_HARD" -gt 0 ] && { err "$MISSING_HARD required tool(s) missing."; exit 1; }
  ok "All required tooling present."
  exit 0
fi

if [ -n "${PMD_TO_INSTALL:-}" ]; then
  info "Missing packages:${PMD_TO_INSTALL}"
  for f in ${PMD_TO_INSTALL}; do brew_install "$f" || true; done
  say ""
fi

# --- Start the runtime -------------------------------------------------------
# The whole point of the "dynamic start" requirement: don't make the user
# remember to boot a VM before running the app.
info "Ensuring the Docker daemon is running"
start_container_runtime || die "Could not start a container runtime. See the guidance above."
say ""

# --- Generate .env -----------------------------------------------------------
# The repo is public, so .env is always generated locally and never committed.
if [ ! -f "$PMD_ROOT/.env" ]; then
  info "Creating .env from .env.example (secrets generated locally)"
  if [ ! -f "$PMD_ROOT/.env.example" ]; then
    warn ".env.example is missing; skipping."
  else
    sed -e "s|__GENERATED_DB_PASSWORD__|$(rand_secret 32)|" \
        -e "s|__GENERATED_APP_SECRET__|$(rand_secret 48)|" \
        "$PMD_ROOT/.env.example" > "$PMD_ROOT/.env"
    chmod 600 "$PMD_ROOT/.env"
    ok "Wrote .env (chmod 600, gitignored)."
  fi
else
  ok ".env already exists; leaving it alone."
fi

mkdir -p "$PMD_LOG_DIR"

hr
if [ "$MISSING_HARD" -gt 0 ]; then
  err "Still missing $MISSING_HARD required tool(s). Re-run after installing."
  exit 1
fi
ok "Preflight passed."
[ "$MISSING_SOFT" -gt 0 ] && dim "($MISSING_SOFT optional tool(s) absent -- fine for running the app.)"
say ""
say "Next:  ${C_BOLD}./scripts/dev.sh${C_RESET}   (starts db, runs migrations, seeds, launches the web app)"
hr
