#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-e|--env <path>] [-v|--volumes]

Stop the local development environment started by start-dev.sh.

Stops all Docker Compose services (including Zitadel). By default, volumes
are kept so data persists across restarts. Pass --volumes to remove them,
which resets all databases and Zitadel configuration.

Environment file precedence (first match wins):
  1. --env <path>      if provided
  2. .env.dev          if present in the repo root
  3. .env.testing      fallback (always present, safe test credentials)

Options:
  -e, --env <path>    Environment file to use
  -v, --volumes       Also remove volumes (resets all data)
  -h, --help          Show this help message and exit
EOF
}

# Argument parsing

ENV_FILE=""
REMOVE_VOLUMES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    -v|--volumes) REMOVE_VOLUMES=true; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Resolve env file

if [[ -z "$ENV_FILE" ]]; then
  if [[ -f "$REPO_ROOT/.env.dev" ]]; then
    ENV_FILE="$REPO_ROOT/.env.dev"
  else
    ENV_FILE="$REPO_ROOT/.env.testing"
  fi
fi

[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

# Stop the Vite dev server, if start-dev.sh --dev-web left one running.
#
# Children first: killing the npm wrapper alone reparents vite, which keeps the
# port held and makes the next `start-dev.sh --dev-web` think a server is
# already up and reuse a process nobody owns.
DEV_WEB_PID_FILE="$REPO_ROOT/.tcp-web-dev.pid"

if [[ -f "$DEV_WEB_PID_FILE" ]]; then
  DEV_WEB_PID="$(cat "$DEV_WEB_PID_FILE")"
  echo "Stopping Vite dev server (pid $DEV_WEB_PID)..."
  pkill -P "$DEV_WEB_PID" 2>/dev/null || true
  kill "$DEV_WEB_PID" 2>/dev/null || true
  rm -f "$DEV_WEB_PID_FILE"
fi

# Stop services

DC="docker compose -p tcp-dev --profile auth --env-file $ENV_FILE"

if [[ "$REMOVE_VOLUMES" == true ]]; then
  echo "Stopping services and removing volumes..."
  $DC down -v
  echo "Done. All data has been reset."
else
  echo "Stopping services (volumes retained)..."
  $DC down
  echo "Done. Run './scripts/start-dev.sh' to restart."
fi
