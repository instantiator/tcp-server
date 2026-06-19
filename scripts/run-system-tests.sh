#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the system test suite against the full running stack.

Starts all services via Docker Compose with the 'auth' profile (including
Keycloak), waits for each to be healthy, then runs 'npm run test:system'.
Tears down all containers on exit.

System tests verify end-to-end health across the full stack: lcp-server,
lcp-agent, PostgreSQL, MinIO, Redis, and Keycloak. The lcp-server /health
endpoint must return 200 (which requires all its dependencies — including
the OIDC provider — to be reachable).

Keycloak can take up to 5 minutes to start on first boot; this script
waits up to 300 seconds before timing out.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="keycloak"

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - Built Docker images (run 'docker compose build' first if images are stale)

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
  local name="$1" cmd="$2" max="${3:-120}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$max" ]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      docker compose --profile auth --env-file "$ENV_FILE" logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

docker compose --profile auth --env-file "$ENV_FILE" up -d

# Keycloak starts slowly — allow up to 5 minutes.
# Use the master realm OIDC discovery URL: always present on a fresh Keycloak,
# served on port 8080 (unlike /health/ready which moved to port 9000 in KC 24+).
wait_for keycloak "curl -sf http://localhost:8080/realms/master/.well-known/openid-configuration" 300

# lcp-server health now includes an OIDC check, so this confirms the full stack.
wait_for lcp-server "curl -sf http://localhost:3000/health"
wait_for lcp-agent "curl -sf http://localhost:3001/health"

npm run test:system -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

docker compose --profile auth --env-file "$ENV_FILE" down
