#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help]

Build the project, lint, and run every test suite in order:
  unit → integration → e2e → api → smoke

The api and smoke suites require a running LCP stack with Keycloak. If
lcp-server is already reachable at http://localhost:3000 the running stack
is reused; otherwise start-deployment.sh starts one automatically using
.env.testing and tears it down on exit.

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

DEPLOYMENT_PROJECT=lcp-all
DEPLOYMENT_STARTED=false

cleanup() {
  local rc=$?
  if [[ "$DEPLOYMENT_STARTED" = "true" ]]; then
    docker compose -p "$DEPLOYMENT_PROJECT" --profile auth down -v
  fi
  exit $rc
}
trap cleanup EXIT

if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  echo "→ lcp-server already running at localhost:3000 — reusing running stack"
else
  DEPLOYMENT_STARTED=true
  "$SCRIPTS/start-deployment.sh" \
    --project "$DEPLOYMENT_PROJECT" \
    --env-file "$REPO_ROOT/.env.testing"
fi

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

step "Docker prune (post-integration)"
docker system prune -f
echo

step "E2E tests"
"$SCRIPTS/run-e2e-tests.sh"
echo

step "Docker prune (post-e2e)"
docker system prune -f
echo

step "API tests"
"$SCRIPTS/run-api-tests.sh" --base-url http://localhost:3000
echo

step "Smoke tests"
"$SCRIPTS/run-smoke-tests.sh" --base-url http://localhost:3000
echo

echo "All steps passed."
echo
