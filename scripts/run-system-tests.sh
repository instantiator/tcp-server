#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.testing"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

set -a; source "$ENV_FILE"; set +a

wait_for() {
  local name="$1" cmd="$2" max="${3:-120}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$max" ]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      docker compose --env-file "$ENV_FILE" logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

docker compose --env-file "$ENV_FILE" up -d

wait_for lcp-server "curl -sf http://localhost:3000/health"
wait_for lcp-agent "curl -sf http://localhost:3001/health"

npm run test:system

docker compose --env-file "$ENV_FILE" down
