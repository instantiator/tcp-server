#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help]

Build the project, lint, and run every test suite in order:
  unit → integration → e2e → api → smoke

Unit, integration, and e2e suites manage their own Docker infrastructure.
The api and smoke suites require the full LCP stack — this script starts it
automatically using .env.testing and tears it down on exit.

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - No lcp-* containers running (checked at startup to avoid port and queue conflicts)

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

# Pre-flight: bail if any lcp-* containers are already running.
# The integration and e2e suites now get their own testcontainers-managed
# stacks on random host ports, so they no longer collide with a dev stack. This
# check remains for the api/smoke step below, which starts the full deployment
# on fixed host ports (3000, 8080, ...) that a running lcp-dev would clash with.
conflicting=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^lcp-' || true)
if [ -n "$conflicting" ]; then
  echo "ERROR: LCP containers are already running:" >&2
  # shellcheck disable=SC2001 # sed reads better than ${var//} for multi-line prefixing
  echo "$conflicting" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Stop them (e.g. 'docker compose -p lcp-dev down') before running the full suite." >&2
  exit 1
fi

DEPLOYMENT_PROJECT=lcp-all
DEPLOYMENT_STARTED=false

cleanup() {
  local rc=$?
  if [[ "$DEPLOYMENT_STARTED" = "true" ]]; then
    docker compose -p "$DEPLOYMENT_PROJECT" --profile auth down -v 2>/dev/null || true
  fi
  exit $rc
}
trap cleanup EXIT

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

# Integration and e2e suites start their own ephemeral infrastructure
# (postgres, redis, minio, stub-llm) via testcontainers, on random host ports.
# The full lcp-all stack must NOT be running here — its lcp-agent worker would
# compete with the integration test's in-process BullMQ worker for queue jobs.
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

# Start the full stack (including Keycloak) only now, for API and smoke tests.
step "Starting deployment for API + smoke tests"
DEPLOYMENT_STARTED=true
"$SCRIPTS/start-deployment.sh" \
  --project "$DEPLOYMENT_PROJECT" \
  --env-file "$REPO_ROOT/.env.testing" \
  --rebuild
echo

step "API tests"
"$SCRIPTS/run-api-tests.sh" --base-url http://localhost:3000
echo

step "Smoke tests"
"$SCRIPTS/run-smoke-tests.sh" --base-url http://localhost:3000
echo

echo "All steps passed."
echo
