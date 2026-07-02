#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the integration test suite against live infrastructure services.

Starts PostgreSQL, Redis, and MinIO via Docker Compose (using .env.testing),
waits for each to be healthy, then runs 'npm run test:integration'.
Tears down the containers on exit.

Integration tests verify that the application can connect to and use each
service correctly (database queries, Redis pub/sub, MinIO bucket operations).
Mirrors the 'integration-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="redis"

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)

Options:
  -h, --help    Show this help message and exit
EOF
}

PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.testing"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

# Export all vars from .env.testing into the shell so docker compose and npm
# both pick up POSTGRES_PASSWORD, MINIO_ACCESS_KEY, etc.
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$ENV_FILE"
set +a

DC="docker compose -p lcp-integration --env-file $ENV_FILE"

wait_for() {
  local name="$1" cmd="$2" max="${3:-60}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge "$max" ]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      $DC logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

# Detect whether infrastructure services are already bound on the expected ports.
# If they are, skip starting integration containers and use what's there instead.
INFRA_ALREADY_UP=false
if curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1; then
  INFRA_ALREADY_UP=true
  echo "→ Infrastructure services are already running. Reusing them."
fi

# Pause the dev lcp-agent so it does not compete with the test's own BullMQ
# worker for queue jobs. Restart it on exit regardless of test outcome.
DEV_AGENT_RUNNING=false
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'lcp-dev-lcp-agent-1'; then
  DEV_AGENT_RUNNING=true
  echo "→ Pausing dev lcp-agent to avoid queue-job competition..."
  docker stop lcp-dev-lcp-agent-1 2>/dev/null || true
fi

restore_dev_agent() {
  if $INFRA_ALREADY_UP; then
    # Tear down only the stub-llm integration container, leave infra alone.
    $DC --profile integration down 2>/dev/null || true
  else
    $DC down
  fi
  if [ "$DEV_AGENT_RUNNING" = true ]; then
    echo "→ Restarting dev lcp-agent..."
    docker start lcp-dev-lcp-agent-1 2>/dev/null || true
  fi
}
# shellcheck disable=SC2154 # rc is assigned inside the trap string itself
trap 'rc=$?; restore_dev_agent; exit $rc' EXIT

if $INFRA_ALREADY_UP; then
  # Just start the stub-llm sidecar (different port — no conflict with dev).
  $DC --profile integration up -d stub-llm
  wait_for stub-llm "curl -sf http://localhost:3002/health"
else
  $DC down -v
  $DC up -d postgres redis minio
  $DC --profile integration up -d stub-llm

  wait_for postgres "$DC exec -T postgres pg_isready -U lcp"
  wait_for redis "$DC exec -T redis redis-cli ping | grep -q PONG"
  wait_for minio "curl -sf http://localhost:9000/minio/health/live"
  wait_for stub-llm "curl -sf http://localhost:3002/health"
fi

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"
export STUB_LLM_URL="http://localhost:3002/v1"

npm run test:integration -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
