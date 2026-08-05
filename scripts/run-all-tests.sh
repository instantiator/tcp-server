#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help]

Build the project, lint, and run every test suite in order:
  unit → integration → e2e → api → smoke → browser

Unit, integration, and e2e suites manage their own Docker infrastructure.
The api and smoke suites require the full TCP stack — this script starts it
automatically using .env.testing and tears it down on exit.

Prints how long each step took at the end of the run, including when a step
fails (covering everything that ran up to that point). Docker prune steps are
excluded from the per-step list but counted in the wall-clock total.

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - No tcp-* containers running (checked at startup to avoid port and queue conflicts)

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

# shellcheck source=scripts/lib/check-no-tcp-running.sh
source "$SCRIPTS/lib/check-no-tcp-running.sh"

# Pre-flight: bail if any tcp-* containers are already running. Beyond the
# resource contention the sourced check itself guards against, the api/smoke
# step below starts the full deployment on the .env.testing host ports
# (EXPOSE_PORT_API defaults to 3001, plus 8080, ...) that a running tcp-dev
# would collide with outright.
check_no_tcp_containers_running || exit 1

DEPLOYMENT_PROJECT=tcp-all
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
RUN_START=$SECONDS
STEP_START=$SECONDS
STEP_NAMES=()
STEP_SECONDS=()

# Renders a duration in whole seconds as `45s` or `3m 07s`.
format_duration() {
  local total="$1"
  if [[ "$total" -ge 60 ]]; then
    printf '%dm %02ds' "$((total / 60))" "$((total % 60))"
  else
    printf '%ds' "$total"
  fi
}

# Closes off the step now running and files its elapsed time for the summary.
# Docker prune steps are skipped: they are infrastructure housekeeping between
# suites, not work any suite is accountable for.
record_step() {
  local suffix="${1:-}"
  if [[ -z "$CURRENT_STEP" ]]; then return 0; fi
  if [[ "$CURRENT_STEP" == "Docker prune"* ]]; then return 0; fi
  STEP_NAMES+=("${CURRENT_STEP}${suffix}")
  STEP_SECONDS+=("$((SECONDS - STEP_START))")
}

# Prints how long each step took, and the wall-clock time for the whole run
# (which includes the docker prunes omitted above).
print_durations() {
  echo ""
  echo "════════════════════════════════════════"
  echo "  Durations"
  echo "════════════════════════════════════════"
  local width=0 i
  for ((i = 0; i < ${#STEP_NAMES[@]}; i++)); do
    if [[ "${#STEP_NAMES[i]}" -gt "$width" ]]; then width="${#STEP_NAMES[i]}"; fi
  done
  for ((i = 0; i < ${#STEP_NAMES[@]}; i++)); do
    printf '  %-*s  %s\n' "$width" "${STEP_NAMES[i]}" "$(format_duration "${STEP_SECONDS[i]}")"
  done
  printf '  %-*s  %s\n' "$width" "TOTAL (wall clock)" "$(format_duration "$((SECONDS - RUN_START))")"
}

step() {
  record_step
  CURRENT_STEP="$1"
  STEP_START=$SECONDS
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
  record_step " (failed)"
  print_durations
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
# The full tcp-all stack must NOT be running here — its tcp-agent worker would
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

# The deployment publishes tcp-server on EXPOSE_PORT_API from .env.testing
# (testing defaults to 3001 to avoid colliding with a dev stack on 3000). The
# api and smoke tiers must target that same host port, not a hardcoded one.
EXPOSE_PORT_API="$(grep -E '^EXPOSE_PORT_API=' "$REPO_ROOT/.env.testing" | tail -1 | cut -d= -f2)"
API_BASE_URL="http://localhost:${EXPOSE_PORT_API:-3000}"
# Same for tcp-agent, published by --dev-ports on its own port (3004 under
# .env.testing). Read from the file, not this shell: the variable is not
# exported here, so a `${EXPOSE_PORT_AGENT:-3003}` default would silently point
# the smoke tier at the dev stack's port instead.
EXPOSE_PORT_AGENT="$(grep -E '^EXPOSE_PORT_AGENT=' "$REPO_ROOT/.env.testing" | tail -1 | cut -d= -f2)"
AGENT_BASE_URL="http://localhost:${EXPOSE_PORT_AGENT:-3003}"

# Start the full stack (including Zitadel) only now, for API and smoke tests.
step "Starting deployment for API + smoke tests"
DEPLOYMENT_STARTED=true
# --dev-ports: the smoke tier (apps/backend/test/smoke/smoke.spec.ts) hits the MCP servers
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
# --agent-url: tcp-agent is published by --dev-ports on EXPOSE_PORT_AGENT,
# never on 3001 — that is tcp-server's port in .env.testing.
"$SCRIPTS/run-smoke-tests.sh" --base-url "$API_BASE_URL" --agent-url "$AGENT_BASE_URL"
echo

# Runs inside the deployment's lifetime: the stack's tcp-web service is what
# serves the app, and the tier provisions nothing of its own. https because the
# web service is TLS-only — HTTP/2 needs it (ADR-025).
step "Browser tests"
EXPOSE_PORT_WEB="$(grep -E '^EXPOSE_PORT_WEB=' "$REPO_ROOT/.env.testing" | tail -1 | cut -d= -f2)"
"$SCRIPTS/run-browser-tests.sh" --base-url "https://localhost:${EXPOSE_PORT_WEB:-5173}"
echo

record_step
CURRENT_STEP=""

echo "All steps passed."
print_durations
echo
