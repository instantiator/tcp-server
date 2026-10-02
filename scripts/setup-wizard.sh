#!/usr/bin/env bash
# setup-wizard.sh — From a fresh clone to a running TCP stack: checks the
# tools it needs, installs packages, runs the configuration wizard, and
# offers to start the stack.
#
# Usage: ./scripts/setup-wizard.sh
#        ./scripts/setup-wizard.sh --test-config [--env <file>] [--project <name>]
#
# --test-config checks an existing configuration's connections (database,
# Redis, MinIO, OIDC, the internal services, the web client, and the LLM and
# embedding endpoints) instead of running the wizard. --env defaults to
# .env.dev (else .env.testing), --project to tcp-dev — as start-dev.sh.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NODE_WANT="$(tr -d '[:space:]' <.nvmrc)"

# Node: .nvmrc pins the exact release, because native modules are built
# against it. With nvm, install/select it here; nvm's scripts don't survive
# `set -eu`, so relax it while they run.
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [[ -s "$NVM_SH" ]]; then
  set +eu
  # shellcheck source=/dev/null
  . "$NVM_SH"
  if ! nvm install; then
    echo "Error: couldn't install Node $NODE_WANT with nvm. Check your network, or install Node $NODE_WANT by hand and re-run." >&2
    exit 1
  fi
  set -eu
fi

missing=()
for tool in node docker jq curl; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  cat >&2 <<EOF
Error: missing required tools: ${missing[*]}
  node   Node.js $NODE_WANT — easiest via nvm: https://github.com/nvm-sh/nvm
  docker https://docs.docker.com/get-docker/
  jq     https://jqlang.org/download/
  curl   your package manager
EOF
  exit 1
fi

"$REPO_ROOT/scripts/check-node-version.sh"

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is installed but not running. Start Docker and re-run." >&2
  exit 1
fi

# Packages: install when missing or when the lockfile has moved on since the
# last install. postinstall covers apps/tcp-stub-llm.
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "Installing packages (npm ci)..."
  if ! npm ci; then
    cat >&2 <<EOF

Error: package install failed (npm's error is above). Common causes:
  - no network connection
  - a Node version other than $NODE_WANT (you have $(node -v))
  - a stale node_modules — delete it and re-run this script
EOF
    exit 1
  fi
fi

# The wizard's own tsconfig maps @tcp/shared/* onto the library's sources;
# without it, Node's package exports reject the subpath imports.
#
# Not `exec`: when tsx itself can't start (exit 127), the user needs pointing
# at the install step. The wizard's own failures explain themselves.
status=0
npx --yes tsx --tsconfig "$REPO_ROOT/scripts/setup-wizard/tsconfig.json" \
  "$REPO_ROOT/scripts/setup-wizard/index.ts" "$@" || status=$?
if [[ "$status" -eq 127 ]]; then
  echo "Error: couldn't start the wizard (tsx not found). Run 'npm ci' in $REPO_ROOT and try again." >&2
fi
exit "$status"
