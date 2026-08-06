#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-e|--env <path>] [--rebuild] [--dev-web]

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

Options:
  -e, --env <path>   Environment file to use
  --rebuild          Force a Docker image rebuild (passes --build to docker compose up)
  --dev-web          Serve the web client from a Vite dev server instead of the
                     built bundle: starts it on the host and points tcp-web at
                     it. Gives HMR, and is the only mode in which
                     development-only capabilities exist at all — they are
                     compiled out of a production build (docs/web-client.md).
  -h, --help         Show this help message and exit
EOF
}

ENV_FILE=""
REBUILD=false
DEV_WEB=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    --dev-web) DEV_WEB=true; shift ;;
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

ARGS=(--project tcp-dev --env-files "$PRIMARY_ENV" --dev-ports)
[[ "$REBUILD" == true ]] && ARGS+=(--rebuild)

# The Vite dev server, when --dev-web asks for one.
#
# It has to be answering *before* the deployment starts, not after: with the
# overlay in place nginx proxies to it, and start-deployment.sh waits on
# tcp-web serving /config.js — which it cannot do while the upstream is
# refusing connections.
DEV_WEB_PID_FILE="$REPO_ROOT/.tcp-web-dev.pid"
DEV_WEB_LOG="$REPO_ROOT/logs/vite-dev.log"

# Read the port from the same env file the deployment uses, so this and
# docker-compose.dev-web.yml's WEB_UPSTREAM cannot disagree. Sourced in a
# subshell: this script deliberately does not carry the env file's variables
# into start-deployment.sh, which loads them itself with its own precedence.
read_dev_web_port() {
  (
    set -a
    # shellcheck disable=SC1090 # path is only known at runtime
    . "$PRIMARY_ENV" >/dev/null 2>&1 || true
    set +a
    echo "${EXPOSE_PORT_WEB_DEV:-4173}"
  )
}

start_dev_web() {
  local port="$1" waited=0

  if curl -sf -o /dev/null "http://localhost:$port/"; then
    echo "Vite dev server already running on port $port — using it."
    return 0
  fi

  mkdir -p "$(dirname "$DEV_WEB_LOG")"
  echo "Starting Vite dev server on port $port (logs: $DEV_WEB_LOG)..."
  npm run dev --workspace apps/frontend/tcp-frontend >"$DEV_WEB_LOG" 2>&1 &
  echo $! >"$DEV_WEB_PID_FILE"

  # Vite binds in a second or two; 30 is slack for a cold dependency
  # optimisation pass, not an expectation.
  until curl -sf -o /dev/null "http://localhost:$port/"; do
    if (( waited >= 30 )); then
      echo "ERROR: Vite dev server did not answer on port $port within ${waited}s." >&2
      echo "Last lines of $DEV_WEB_LOG:" >&2
      tail -20 "$DEV_WEB_LOG" >&2 || true
      stop_dev_web
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "Vite dev server is up."
}

# Kill the npm wrapper and the vite process it spawned. Children first: killing
# the parent alone reparents vite and leaves the port held, which then looks
# like "already running" on the next start.
stop_dev_web() {
  [[ -f "$DEV_WEB_PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$DEV_WEB_PID_FILE")"
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  rm -f "$DEV_WEB_PID_FILE"
}

if [[ "$DEV_WEB" == true ]]; then
  DEV_WEB_PORT="$(read_dev_web_port)"
  start_dev_web "$DEV_WEB_PORT"
  ARGS+=(--dev-web)
fi

# Not `exec`: the closing note below has to outlive start-deployment.sh, and a
# failed start must not leave an orphaned dev server behind.
if ! "$REPO_ROOT/scripts/start-deployment.sh" "${ARGS[@]}"; then
  status=$?
  [[ "$DEV_WEB" == true ]] && stop_dev_web
  exit "$status"
fi

if [[ "$DEV_WEB" == true ]]; then
  echo "Web client: Vite dev server (HMR), proxied by tcp-web."
  echo "  Logs:  $DEV_WEB_LOG"
  echo "  Stop:  ./scripts/stop-dev.sh  (stops the dev server too)"
else
  echo "Web client: the built bundle — a production build."
  echo "  Development-only capabilities are compiled out of it, so ?devSession="
  echo "  and anything like it will not work here. Restart with --dev-web for"
  echo "  those, and for HMR. See docs/web-client.md."
fi
echo ""
