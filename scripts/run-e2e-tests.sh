#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the end-to-end test suite against a live NestJS application.

Starts PostgreSQL, Redis, and MinIO via Docker Compose (using .env.testing),
then runs 'npm run test:e2e' with DATABASE_URL pointed at the local postgres
instance. Tears down the containers on exit.

No Keycloak required — OIDC env vars are sourced from .env.testing as stubs.
Mirrors the 'e2e-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"
  $(basename "$0") -- --testPathPattern="api"

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

set -a; source "$ENV_FILE"; set +a

wait_for() {
  local name="$1" cmd="$2" max="${3:-60}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge "$max" ]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      docker compose --env-file "$ENV_FILE" logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

docker compose --env-file "$ENV_FILE" up -d postgres redis minio

wait_for postgres "docker compose exec -T postgres pg_isready -U lcp"

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"
export OIDC_ISSUER_URL
export OIDC_CLIENT_ID
export OIDC_CLIENT_SECRET

npm run test:e2e -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

docker compose --env-file "$ENV_FILE" down
