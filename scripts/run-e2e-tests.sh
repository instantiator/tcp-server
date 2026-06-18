#!/usr/bin/env bash
set -euo pipefail

docker compose up -d postgres redis minio

echo "Waiting for postgres to be healthy..."
until docker compose exec -T postgres pg_isready -U lcp 2>/dev/null; do sleep 2; done

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD:-dev-password}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-lcp-access-key}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-lcp-secret-key}"
export OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-http://localhost:8080/realms/lcp}"
export OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-lcp-server}"
export OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-stub}"

npm run test:e2e

docker compose down
