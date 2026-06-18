#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.testing"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

# Export all vars from .env.testing into the shell so docker compose and npm
# both pick up POSTGRES_PASSWORD, MINIO_ACCESS_KEY, etc.
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
wait_for redis "docker compose exec -T redis redis-cli ping | grep -q PONG"
wait_for minio "curl -sf http://localhost:9000/minio/health/live"

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"

npm run test:integration

docker compose --env-file "$ENV_FILE" down
