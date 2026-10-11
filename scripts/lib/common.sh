#!/usr/bin/env bash
# Shared helpers for the setup scripts.
#
# Written against bash 3.2, the version macOS still ships at /bin/bash, so no
# associative arrays, no ${var,,}, no `mapfile`. Sourced, never executed.

# Guard against double-sourcing when scripts chain into each other.
[ -n "${PMD_COMMON_LOADED:-}" ] && return 0
PMD_COMMON_LOADED=1

set -o pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PMD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PMD_ROOT="$(cd "$PMD_SCRIPT_DIR/.." && pwd)"
PMD_LOG_DIR="$PMD_ROOT/logs"
export PMD_ROOT PMD_LOG_DIR

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
# Only colourise when stdout is a TTY, so piping to a file or CI stays clean.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m';  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m';  C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m';  C_CYN=$'\033[36m'
else
  C_RESET=; C_DIM=; C_BOLD=; C_RED=; C_GRN=; C_YEL=; C_BLU=; C_CYN=
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$C_BLU$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GRN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YEL" "$C_RESET" "$*" >&2; }
err()  { printf '%s FAIL%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die()  { err "$*"; exit 1; }

hr() { printf '%s%s%s\n' "$C_DIM" "------------------------------------------------------------" "$C_RESET"; }

# ---------------------------------------------------------------------------
# Interactivity
# ---------------------------------------------------------------------------
# Scripts must be runnable unattended (CI, agents) and interactively (humans).
# PMD_ASSUME_YES=1 or --yes answers every prompt with its default.
pmd_is_interactive() {
  [ -t 0 ] && [ -z "${PMD_ASSUME_YES:-}" ] && [ -z "${CI:-}" ]
}

# confirm "Question?" [default_yes|default_no]
# Returns 0 for yes, 1 for no. Non-interactive runs take the default silently.
confirm() {
  local prompt="$1" default="${2:-default_no}" reply suffix
  if [ "$default" = "default_yes" ]; then suffix="[Y/n]"; else suffix="[y/N]"; fi

  if ! pmd_is_interactive; then
    [ "$default" = "default_yes" ] && return 0 || return 1
  fi

  printf '%s?%s %s %s ' "$C_CYN$C_BOLD" "$C_RESET" "$prompt" "$suffix"
  read -r reply </dev/tty || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    [nN]|[nN][oO])     return 1 ;;
    "") [ "$default" = "default_yes" ] && return 0 || return 1 ;;
    *)  [ "$default" = "default_yes" ] && return 0 || return 1 ;;
  esac
}

# ask "Prompt" "fallback" -> echoes the answer
ask() {
  local prompt="$1" fallback="$2" reply
  if ! pmd_is_interactive; then printf '%s' "$fallback"; return 0; fi
  printf '%s?%s %s %s(%s)%s ' "$C_CYN$C_BOLD" "$C_RESET" "$prompt" "$C_DIM" "$fallback" "$C_RESET"
  read -r reply </dev/tty || reply=""
  [ -n "$reply" ] && printf '%s' "$reply" || printf '%s' "$fallback"
}

# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# Pull the first dotted version number out of arbitrary `--version` output.
version_of() {
  "$@" 2>&1 | head -5 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

# version_gte 3.14.1 3.11  -> 0 when the first is >= the second
version_gte() {
  [ -z "$1" ] && return 1
  [ "$1" = "$2" ] && return 0
  # sort -V puts the lower version first; if that's $2 then $1 is the bigger one.
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V 2>/dev/null | head -1)" = "$2" ]
}

# ---------------------------------------------------------------------------
# Homebrew
# ---------------------------------------------------------------------------
brew_bin() {
  if have brew; then command -v brew; return 0; fi
  # Homebrew may be installed but absent from a non-login shell's PATH.
  for c in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# Install a formula, asking first unless --yes. Returns non-zero if unavailable
# or declined, so callers can degrade instead of hard-failing.
brew_install() {
  local formula="$1" b
  b="$(brew_bin)" || { warn "Homebrew not found; install $formula manually."; return 1; }
  if ! confirm "Install $formula with Homebrew?" default_yes; then
    warn "Skipped installing $formula."
    return 1
  fi
  info "brew install $formula"
  "$b" install "$formula"
}

# ---------------------------------------------------------------------------
# Container runtime
# ---------------------------------------------------------------------------
# The project only needs *a* working Docker daemon. Several macOS runtimes can
# provide one, so detect rather than assume, and start whichever is installed.
# Echoes one of: colima | docker-desktop | orbstack | podman | none
detect_container_runtime() {
  if have colima; then say colima; return 0; fi
  if have orb || [ -d /Applications/OrbStack.app ]; then say orbstack; return 0; fi
  if [ -d /Applications/Docker.app ]; then say docker-desktop; return 0; fi
  if have podman; then say podman; return 0; fi
  say none
}

docker_daemon_up() { have docker && docker info >/dev/null 2>&1; }

# Block until the daemon answers, or give up. Starting a VM is not instant and
# the socket appears before the daemon is actually ready to serve.
wait_for_docker() {
  local tries="${1:-60}" i=0
  while [ "$i" -lt "$tries" ]; do
    docker_daemon_up && return 0
    sleep 2; i=$((i + 1))
    [ $((i % 5)) -eq 0 ] && dim "    still waiting for the Docker daemon (${i}0s)..."
  done
  return 1
}

# Start whatever runtime is present. Safe to call when already running.
start_container_runtime() {
  if docker_daemon_up; then ok "Docker daemon already running."; return 0; fi

  local rt; rt="$(detect_container_runtime)"
  case "$rt" in
    colima)
      info "Starting Colima (${PMD_COLIMA_CPU:-4} CPU / ${PMD_COLIMA_MEM:-6}GB / ${PMD_COLIMA_DISK:-60}GB)..."
      dim "    first run downloads a VM image; this can take several minutes."
      colima start \
        --cpu "${PMD_COLIMA_CPU:-4}" \
        --memory "${PMD_COLIMA_MEM:-6}" \
        --disk "${PMD_COLIMA_DISK:-60}" || return 1
      ;;
    orbstack)
      info "Starting OrbStack..."
      open -ga OrbStack || return 1
      ;;
    docker-desktop)
      info "Starting Docker Desktop..."
      open -ga Docker || return 1
      ;;
    podman)
      info "Starting the Podman machine..."
      podman machine start || return 1
      ;;
    none)
      err "No container runtime found, and Postgres runs in Docker."
      say ""
      say "  Colima is the lightweight CLI option (no GUI, no licence terms):"
      say "      brew install colima docker docker-compose"
      say "  Or install Docker Desktop / OrbStack as a GUI alternative."
      say ""
      if confirm "Install Colima + Docker CLI now?" default_yes; then
        brew_install colima && brew_install docker && brew_install docker-compose \
          && start_container_runtime
        return $?
      fi
      return 1
      ;;
  esac

  info "Waiting for the Docker daemon to accept connections..."
  wait_for_docker 90 || { err "Runtime '$rt' started but the daemon never came up."; return 1; }
  ok "Docker daemon is up (via $rt)."
}

# `docker compose` (v2 plugin) vs `docker-compose` (standalone v1) differ by
# install method. Echo whichever actually works so callers don't guess.
compose_cmd() {
  if docker compose version >/dev/null 2>&1; then say "docker compose"; return 0; fi
  if have docker-compose; then say "docker-compose"; return 0; fi
  return 1
}

# Homebrew's docker-compose formula drops the plugin somewhere the Docker CLI
# doesn't search, which makes `docker compose` fail even though it's installed.
# Linking it is the documented fix and is idempotent.
link_compose_plugin() {
  docker compose version >/dev/null 2>&1 && return 0
  local b src; b="$(brew_bin)" || return 1
  src="$("$b" --prefix 2>/dev/null)/lib/docker/cli-plugins/docker-compose"
  [ -x "$src" ] || return 1
  info "Linking the Compose plugin where the Docker CLI looks for it..."
  mkdir -p "$HOME/.docker/cli-plugins"
  ln -sfn "$src" "$HOME/.docker/cli-plugins/docker-compose"
  docker compose version >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Env file
# ---------------------------------------------------------------------------
# .env is gitignored and the repo is public, so it is generated locally and
# never committed. Secrets are random per machine.
# Emits exactly N alphanumeric characters, and nothing else.
#
# Restricted to [A-Za-z0-9] on purpose: the result is written into a .env that
# gets shell-sourced and embedded in a postgres:// URL, so a stray quote, space
# or '#' would break one or both. (An earlier version fell back to `shasum`,
# whose output ends in "  -" for stdin -- that trailing dash landed in .env and
# bash tried to execute it.)
rand_secret() {
  local n="${1:-32}" out=""

  # `head -c` closes the pipe, which kills `tr` with SIGPIPE and makes it exit
  # non-zero. Under `set -o pipefail` that reads as failure even though the
  # output is perfectly good, so the status is explicitly discarded and the
  # result is validated by length instead.
  out="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "$n" || true)"

  if [ "${#out}" -lt "$n" ] && have openssl; then
    out="$(openssl rand -base64 "$((n * 2))" 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c "$n" || true)"
  fi

  [ "${#out}" -eq "$n" ] || die "Could not generate a ${n}-character random secret."
  printf '%s' "$out"
}

load_env() {
  [ -f "$PMD_ROOT/.env" ] || return 0
  set -a
  # shellcheck disable=SC1091
  . "$PMD_ROOT/.env"
  set +a
}
