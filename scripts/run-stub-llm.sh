#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/lcp-stub-llm"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--config <path>] [--port <n>]

Runs lcp-stub-llm directly from source (no build step — it's plain
TypeScript run by Node's native type-stripping), for manual testing.

Options:
  --config <path>   Config file to load on startup (JSON/JSONC)
  --port <n>        Port to listen on (default: 3002)
  -h, --help        Show this help message and exit
EOF
}

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --config)
      [[ -n "${2:-}" ]] || { echo "ERROR: --config requires a path" >&2; exit 1; }
      ARGS+=(--config "$2"); shift 2 ;;
    --port)
      [[ -n "${2:-}" ]] || { echo "ERROR: --port requires a value" >&2; exit 1; }
      ARGS+=(--port "$2"); shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

exec node "$APP_DIR/src/main.ts" ${ARGS[@]+"${ARGS[@]}"}
