#!/usr/bin/env bash
# Refresh the screenshots used in the README and the docs.
#
#   ./scripts/screenshots.sh            # construction preset (the default set)
#   ./scripts/screenshots.sh software   # regenerate for a different preset
#
# These are documentation artefacts with a deliberate refresh, not build output.
# They are NOT regenerated on every commit: committing binary PNGs on each
# commit bloats the history permanently, and a pre-commit hook that boots
# Docker, Postgres and a browser gets bypassed within a day.
#
# The same capture serves the regression baselines and the documentation set,
# so the image in the README is the one the suite asserts against and the two
# cannot drift apart.

set -euo pipefail
# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PRESET="${1:-construction}"
cd "$PMD_ROOT"

info "Regenerating documentation screenshots from the '$PRESET' preset."
dim "    The clock is pinned, so these are reproducible on any machine."

# PMDASH_WRITE_DOCS makes the capture helper write docs/screenshots/ in
# addition to comparing against the baseline.
PMDASH_WRITE_DOCS=1 PMDASH_PRESET="$PRESET" npx playwright test --update-snapshots

hr
ok "Written to docs/screenshots/"
ls -1 docs/screenshots/ 2>/dev/null | sed 's/^/    /'
say ""
dim "    Baselines live in tests/visual/__baselines__/<platform>/."
dim "    Linux baselines are the authoritative ones -- see docs/TESTING.md."
