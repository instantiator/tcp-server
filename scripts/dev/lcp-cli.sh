#!/usr/bin/env bash
# lcp-cli.sh — wrapper to run the lcp-cli developer tool.
# Usage: ./scripts/dev/lcp-cli.sh [--rebuild] [lcp-cli options]
#
# Pass --rebuild as the first argument to force a fresh build before running.
# Without --rebuild, the CLI is built automatically only when the dist is missing.

set -euo pipefail

REBUILD=false
if [ "${1:-}" = "--rebuild" ]; then
  REBUILD=true
  shift
fi

ROOT="$(git rev-parse --show-toplevel)"
DIST="$ROOT/dist/apps/lcp-cli/main.js"

# Build the CLI if the compiled output is missing or a rebuild was requested
if [ "$REBUILD" = "true" ] || [ ! -f "$DIST" ]; then
  echo "[lcp-cli] Building lcp-cli..." >&2
  npm --prefix "$ROOT" run build:lcp-cli
fi

exec node "$DIST" "$@"
