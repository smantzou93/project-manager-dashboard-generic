#!/usr/bin/env bash
# Generate the authoritative (Linux) screenshot baselines, on your own machine.
#
#   ./scripts/baselines-linux.sh
#
# Why this exists: font rasterisation differs between macOS and Linux, so a
# baseline captured on a laptop can never match a CI runner. The alternative
# was "push, let CI fail, download an artifact, commit it by hand", which is a
# slow loop and easy to get wrong.
#
# So: the app and the database run on the host as usual, and only the browser
# runs in a Linux container.
#
# It matches CI's platform, NOT its fonts. CI installs Chromium with
# --with-deps on ubuntu-latest, which brings a different font set than this
# image ships, and text width follows the fonts: a page measuring zero
# overflow here overflowed by 35px on a runner. Close enough to chase a
# Linux-only layout bug; not pixel-identical to this CI.
#
# node_modules lives in a named volume rather than the mounted repo, because
# the host's copy contains macOS binaries that cannot execute in the container.
# First run installs into it; later runs reuse it.

set -euo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# --check compares instead of rewriting, which is what CI does. Useful for
# confirming the committed baselines still hold before pushing.
MODE=--update-snapshots
if [ "${1:-}" = "--check" ]; then MODE=""; shift; fi

PORT="${PMDASH_TEST_PORT:-3210}"
PRESET="${1:-construction}"
PINNED_CLOCK="2026-10-01T12:00:00Z"
VOLUME=pmdash-linux-node-modules

# Keep in step with the devDependency, or the container's browser build will
# not match the one the suite expects.
PW_VERSION="$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null || echo '')"
[ -n "$PW_VERSION" ] || die "Could not read the installed Playwright version. Run npm install first."
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

cd "$PMD_ROOT"

start_container_runtime || die "Need a running Docker daemon."

info "Preparing the pinned fixture..."
./scripts/dev.sh --yes --pinned --preset "$PRESET" --seed-only >/dev/null

# -H 0.0.0.0 so the container can reach it; on loopback only it cannot.
info "Starting the app on the host (port $PORT)..."
set -a; . ./.env; set +a
PMDASH_AS_OF="$PINNED_CLOCK" npx next dev apps/web -p "$PORT" -H 0.0.0.0 \
  >"$PMD_LOG_DIR/baselines-server.log" 2>&1 &
SERVER_PID=$!
# shellcheck disable=SC2064
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || die "The app did not start. See $PMD_LOG_DIR/baselines-server.log"
ok "App is up."

info "Running the visual suite in $IMAGE..."
dim "    first run installs dependencies into the '$VOLUME' volume; later runs reuse it."

docker run --rm -t \
  -v "$PMD_ROOT:/work" \
  -v "$VOLUME:/work/node_modules" \
  -w /work \
  -e PMDASH_BASE_URL="http://host.docker.internal:$PORT" \
  -e CI=1 \
  --add-host=host.docker.internal:host-gateway \
  "$IMAGE" \
  bash -lc '
    set -e
    if [ ! -d node_modules/@playwright/test ]; then
      echo "installing dependencies (first run only)..."
      npm ci --no-audit --no-fund
    fi
    npx playwright test --project=desktop --project=dark --project=mobile '"$MODE"'
  '

hr
if [ -n "$MODE" ]; then
  ok "Linux baselines written."
else
  ok "Linux baselines match."
fi
ls -1 tests/visual/__baselines__/linux/ 2>/dev/null | sed 's/^/    /'
say ""
dim "    These are the ones CI compares against. Commit them."
