#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-e|--env <path>] [--rebuild]

Start a full local development environment and configure it for first-time use.

Starts all services via Docker Compose (including Zitadel when
ZITADEL_ADMIN_PASSWORD is set), waits for each to be healthy, then creates
the Zitadel project, application, and test users. Safe to re-run — existing
resources are left untouched.

Credentials for the Zitadel org and test users are read from the env file
(TEST_USERNAME, TEST_PASSWORD). Add or override them there.

Environment file precedence (first match wins):
  1. --env <path>      if provided
  2. .env.dev          if present in the repo root
  3. .env.testing      fallback (always present, safe test credentials)

.env.defaults is always loaded as a fallback after the primary env file,
providing default values for optional environment variables.

Options:
  -e, --env <path>   Environment file to use
  --rebuild          Force a Docker image rebuild (passes --build to docker compose up)
  -h, --help         Show this help message and exit
EOF
}

ENV_FILE=""
REBUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Resolve env file (cascade: .env.dev → .env.testing)
PRIMARY_ENV=""
if [[ -n "$ENV_FILE" ]]; then
  PRIMARY_ENV="$ENV_FILE"
elif [[ -f "$REPO_ROOT/.env.dev" ]]; then
  PRIMARY_ENV="$REPO_ROOT/.env.dev"
else
  PRIMARY_ENV="$REPO_ROOT/.env.testing"
fi

[[ -f "$PRIMARY_ENV" ]] || { echo "ERROR: env file not found: $PRIMARY_ENV" >&2; exit 1; }

# Build env file list with defaults as fallback
ENV_FILE_LIST="$PRIMARY_ENV"
if [[ -f "$REPO_ROOT/.env.defaults" ]]; then
  ENV_FILE_LIST="$PRIMARY_ENV,$REPO_ROOT/.env.defaults"
fi

ARGS=(--project lcp-dev --env-files "$ENV_FILE_LIST")
[[ "$REBUILD" == true ]] && ARGS+=(--rebuild)

exec "$REPO_ROOT/scripts/start-deployment.sh" "${ARGS[@]}"
