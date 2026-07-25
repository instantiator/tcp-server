#!/usr/bin/env bash
# check-migrations.sh — MANUAL DIAGNOSTIC: show how the entity models differ
# from the committed migrations.
#
# Spins up a throwaway Postgres, applies every committed migration, then asks
# TypeORM to generate a migration from the current entity models and prints
# whatever it would emit.
#
# NOT wired into pre-push, and NOT a clean pass/fail gate for this repo: the
# models intentionally diverge from the Postgres migrations (varchar for
# UUID/date columns for SQLite cross-compat) and use pgvector types TypeORM
# can't introspect, so the output ALWAYS includes phantom drift (uuid<->varchar,
# timestamp<->timestamptz, vector column drop/add, index-name churn). Use it to
# eyeball genuine schema changes among that noise, not as a push blocker — the
# pre-push hook uses a git-scoped heuristic instead.
#
# Requires Docker and .env.testing. Uses an isolated compose project and a
# fresh volume, so it never touches dev or test data.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env.testing"
PROJECT=lcp-migcheck

if ! docker info >/dev/null 2>&1; then
  echo "✗ check-migrations: Docker is not running." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ check-migrations: $ENV_FILE not found." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$ENV_FILE"
set +a

# shellcheck source=scripts/lib/derive-urls.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/derive-urls.sh"
derive_host_urls

DC=(docker compose -p "$PROJECT" --env-file "$ENV_FILE")
GEN_DIR="$(mktemp -d)"
# shellcheck disable=SC2329 # invoked indirectly via the EXIT trap below
cleanup() {
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$GEN_DIR"
}
trap cleanup EXIT

echo "→ check-migrations: starting throwaway Postgres..."
"${DC[@]}" down -v >/dev/null 2>&1 || true
"${DC[@]}" up -d postgres >/dev/null

echo "→ check-migrations: waiting for Postgres..."
for _ in $(seq 1 30); do
  "${DC[@]}" exec -T postgres pg_isready -U lcp >/dev/null 2>&1 && break
  sleep 1
done
if ! "${DC[@]}" exec -T postgres pg_isready -U lcp >/dev/null 2>&1; then
  echo "✗ check-migrations: Postgres did not become ready." >&2
  "${DC[@]}" logs --tail=20 postgres >&2
  exit 1
fi

echo "→ check-migrations: applying committed migrations..."
npm run --silent migration:run >/dev/null

echo "→ check-migrations: comparing entity models against migrations..."
set +e
GEN_OUT="$(npm run --silent migration:generate -- "$GEN_DIR/DriftCheck" 2>&1)"
GEN_RC=$?
set -e

# migration:generate exits 0 (and writes a file) only when it found changes to
# emit; it exits non-zero with "No changes in database schema..." when in sync.
if [ "$GEN_RC" -eq 0 ]; then
  echo ""
  echo "→ check-migrations: TypeORM would emit the following to reconcile the"
  echo "  models with the migrations. Remember most of this is phantom drift"
  echo "  (uuid<->varchar, timestamp<->timestamptz, vector, index names) — scan"
  echo "  for genuine column/table changes among it:"
  echo ""
  sed -n 's/^/    /p' "$GEN_DIR"/*DriftCheck.ts 2>/dev/null || true
  exit 0
fi

if echo "$GEN_OUT" | grep -q "No changes in database schema"; then
  echo "✓ check-migrations: models and migrations are fully in sync."
  exit 0
fi

echo "✗ check-migrations: migration:generate failed unexpectedly:" >&2
echo "$GEN_OUT" >&2
exit 1
