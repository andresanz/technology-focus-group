#!/usr/bin/env bash
# deploy-assets — install static assets from the repo to their server paths.
#
# Idempotent: copies assets/parked.html to the parked webroot. Run after a
# git pull whenever the parked page changes.
#
#   sudo ./scripts/deploy-assets.sh
#
# Respects the same env overrides the app uses.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARKED_ROOT="${PARKED_ROOT:-/var/www/parked}"

mkdir -p "$PARKED_ROOT"
install -m 644 "$REPO_DIR/assets/parked.html" "$PARKED_ROOT/index.html"
echo "installed parked page -> $PARKED_ROOT/index.html"
