#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help]

Build the project, lint, and run every test suite in order:
  unit → integration → e2e → api → smoke

Each suite is delegated to its own script, which manages Docker services
as needed. A failure in any step aborts the remainder.

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)

Options:
  -h, --help    Show this help message and exit
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"

CURRENT_STEP=""

step() {
  CURRENT_STEP="$1"
  echo ""
  echo "════════════════════════════════════════"
  echo "  $CURRENT_STEP"
  echo "════════════════════════════════════════"
}

on_error() {
  echo ""
  echo "════════════════════════════════════════"
  echo "  FAILED: $CURRENT_STEP"
  echo "════════════════════════════════════════"
  exit 1
}

trap on_error ERR

step "Type check"
npm --prefix "$REPO_ROOT" run typecheck
echo

step "Build"
npm --prefix "$REPO_ROOT" run build
echo

step "Lint"
npm --prefix "$REPO_ROOT" run lint:check
echo

step "Unit tests"
"$SCRIPTS/run-unit-tests.sh"
echo

step "Integration tests"
"$SCRIPTS/run-integration-tests.sh"
echo

step "E2E tests"
"$SCRIPTS/run-e2e-tests.sh"
echo

step "API tests"
"$SCRIPTS/run-api-tests.sh"
echo

step "Smoke tests"
"$SCRIPTS/run-smoke-tests.sh"
echo

echo "All steps passed."
echo