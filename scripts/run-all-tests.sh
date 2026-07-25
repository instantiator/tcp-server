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

# shellcheck source=scripts/lib/check-no-lcp-running.sh
source "$SCRIPTS/lib/check-no-lcp-running.sh"

# Pre-flight: bail if any lcp-* containers are already running. Beyond the
# resource contention the sourced check itself guards against, the api/smoke
# step below starts the full deployment on the .env.testing host ports
# (EXPOSE_PORT_API defaults to 3001, plus 8080, ...) that a running lcp-dev
# would collide with outright.
check_no_lcp_containers_running || exit 1

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

# The deployment publishes lcp-server on EXPOSE_PORT_API from .env.testing
# (testing defaults to 3001 to avoid colliding with a dev stack on 3000). The
# api and smoke tiers must target that same host port, not a hardcoded one.
EXPOSE_PORT_API="$(grep -E '^EXPOSE_PORT_API=' "$REPO_ROOT/.env.testing" | tail -1 | cut -d= -f2)"
API_BASE_URL="http://localhost:${EXPOSE_PORT_API:-3000}"

# Start the full stack (including Zitadel) only now, for API and smoke tests.
step "Starting deployment for API + smoke tests"
DEPLOYMENT_STARTED=true
# --dev-ports: the smoke tier (test/smoke/smoke.spec.ts) hits the MCP servers
# directly on their host ports, so they must be published for this run.
"$SCRIPTS/start-deployment.sh" \
  --project "$DEPLOYMENT_PROJECT" \
  --env-file "$REPO_ROOT/.env.testing" \
  --rebuild \
  --dev-ports
echo

step "API tests"
# Read the machine test user's credentials from the SAME env file the
# deployment was bootstrapped with (start-deployment.sh wrote a fresh
# TEST_CLIENT_ID/SECRET into it) — not run-api-tests.sh's default, which would
# prefer a stale .env if one happens to be present in the repo root.
"$SCRIPTS/run-api-tests.sh" --base-url "$API_BASE_URL" --env-file "$REPO_ROOT/.env.testing"
echo

step "Smoke tests"
"$SCRIPTS/run-smoke-tests.sh" --base-url "$API_BASE_URL"
echo

echo "All steps passed."
echo
