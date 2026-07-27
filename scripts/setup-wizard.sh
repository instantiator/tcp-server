#!/usr/bin/env bash
# setup-wizard.sh — Launch the TCP Server setup wizard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not found." >&2
  echo "Install it from https://nodejs.org/" >&2
  exit 1
fi

# Check for tsx (used to run TypeScript directly)
if ! npx --yes tsx --version >/dev/null 2>&1; then
  echo "Installing tsx..." >&2
  npm install --no-save tsx 2>/dev/null
fi

exec npx --yes tsx "$REPO_ROOT/scripts/setup-wizard/index.ts" "$@"
