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
set -a; source "$ENV_FILE"; set +a

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

trap 'rc=$?; $DC down; exit $rc' EXIT
$DC down -v
$DC up -d postgres redis minio
# stub-llm runs under the 'integration' profile so it only starts during tests
$DC --profile integration up -d stub-llm

wait_for postgres "$DC exec -T postgres pg_isready -U lcp"
wait_for redis "$DC exec -T redis redis-cli ping | grep -q PONG"
wait_for minio "curl -sf http://localhost:9000/minio/health/live"
wait_for stub-llm "curl -sf http://localhost:3002/health"

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"
export STUB_LLM_URL="http://localhost:3002/v1"

npm run test:integration -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

$DC down
