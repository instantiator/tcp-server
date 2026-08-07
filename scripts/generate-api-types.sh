#!/usr/bin/env bash
# Regenerates the web client's API types from a running tcp-server.
#
# The OpenAPI description is produced at runtime from tcp-server's controller
# metadata (ADR-014), so there is no way to generate these types from source
# alone — this needs a server to read GET /swagger-json from. Point --base-url
# at one, or set API_BASE_URL.
#
# Never edit apps/frontend/tcp-frontend/src/api/schema.d.ts by hand — it joins
# schemas/schema.json and docs/licenses.md as a generated artefact. CI's
# api-test job regenerates it against the deployment it has already booted and
# fails if the committed copy differs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

base_url="${API_BASE_URL:-http://localhost:3000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      base_url="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--base-url http://localhost:3000]" >&2
      exit 2
      ;;
  esac
done

out="$REPO_ROOT/apps/frontend/tcp-frontend/src/api/schema.d.ts"

# `npm exec --workspace`, not `npx`: openapi-typescript is a devDependency of
# the frontend workspace and npm does not hoist its binary to the root .bin.
# That also means the command runs with the workspace as its cwd, so --output
# is absolute. `--no` fails on a missing package rather than downloading one.
npm exec --no --workspace apps/frontend/tcp-frontend -- \
  openapi-typescript "${base_url}/swagger-json" --output "$out"
