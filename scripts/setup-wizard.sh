#!/usr/bin/env bash
# setup-wizard.sh — From a fresh clone to a running TCP stack: checks the
# tools it needs, installs packages, runs the configuration wizard, and
# offers to start the stack.
set -euo pipefail

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
  nvm install
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
  npm ci
fi

exec npx --yes tsx "$REPO_ROOT/scripts/setup-wizard/index.ts" "$@"
