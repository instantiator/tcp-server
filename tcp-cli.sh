#!/usr/bin/env bash
# tcp-cli.sh — wrapper to run the tcp-cli developer tool.
#
# Usage: ./tcp-cli.sh [--rebuild] [-e|--env <file>] [tcp-cli options]
#
# Wrapper-only flags — recognised ONLY up to the first argument that isn't one
# of these (typically the verb name); everything from that point on is passed
# straight through to the node binary untouched, so a subcommand is free to
# define its own -e or any other short flag without colliding with the
# wrapper's:
#   --rebuild          Force a fresh build even if dist/ is present.
#   -e, --env <file>   Environment file to load. When provided, also syncs the
#                      running tcp-server and tcp-agent Docker containers with
#                      the new vars (docker compose up -d). Precedence:
#                        1. --env <file>   (explicit)
#                        2. .env           (repo root, if present)
#                        3. .env.testing   (always present, safe test defaults)

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# Parse wrapper-level flags, collecting everything else for the node binary.
REBUILD=false
EXPLICIT_ENV=""
NODE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild)
      REBUILD=true; shift ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      EXPLICIT_ENV="$2"; shift 2 ;;
    *)
      # First non-wrapper token (the verb, or anything else): stop parsing
      # wrapper flags here — this and everything after it belongs to the node
      # CLI verbatim, so its own flags (e.g. a subcommand's -e) are untouched.
      NODE_ARGS=("$@")
      break ;;
  esac
done

# Resolve env file: explicit → .env → .env.testing
if [[ -n "$EXPLICIT_ENV" ]]; then
  ENV_FILE="$EXPLICIT_ENV"
elif [[ -f "$ROOT/.env" ]]; then
  ENV_FILE="$ROOT/.env"
else
  ENV_FILE="$ROOT/.env.testing"
fi

[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

# Export all vars from the env file into this process and the node child.
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$ENV_FILE"
set +a

# When an explicit env file was provided, sync the running Docker containers so
# the server picks up any new vars (e.g. LLM_*) without a manual restart.
if [[ -n "$EXPLICIT_ENV" ]]; then
  echo "[tcp-cli] Syncing Docker containers with $ENV_FILE..." >&2
  docker compose -p tcp-dev --env-file "$ENV_FILE" up -d tcp-server tcp-agent \
    2>/dev/null || echo "[tcp-cli] Docker sync skipped (not running)." >&2
fi

DIST="$ROOT/dist/apps/tcp-cli/main.js"

if [ "$REBUILD" = "true" ] || [ ! -f "$DIST" ]; then
  echo "[tcp-cli] Building tcp-cli..." >&2
  npm --prefix "$ROOT" run build:tcp-cli
fi

exec node "$DIST" "${NODE_ARGS[@]+"${NODE_ARGS[@]}"}"
